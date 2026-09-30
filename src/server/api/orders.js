import supabase from './db-client.js';
import { requireMerchant } from './_auth.js';

function calcDelivery(settings, weight, region, subtotal) {
  if (Number(settings.free_threshold ?? 2000) > 0 && subtotal >= Number(settings.free_threshold ?? 2000)) return 0;
  const steps = settings.weight_enabled !== false
    ? Math.ceil(Math.max(0, weight - Number(settings.base_weight ?? 500)) / Math.max(1, Number(settings.weight_step ?? 500)))
    : 0;
  return Number(settings[region] ?? (region === 'outside' ? 130 : 80)) + steps * Number(settings.extra_charge ?? 20);
}

function mapOrder(n) {
  return {
    id: String(n.id),
    created_at: n.created_at,
    createdAt: n.created_at,
    name: n.name,
    phone: n.phone,
    address: n.address,
    region: n.region,
    note: n.note || '',
    items: n.items || [],
    subtotal: Number(n.subtotal || 0),
    weight: Number(n.weight || 0),
    delivery: Number(n.delivery || 0),
    total: Number(n.total || 0),
    status: n.status || 'অপেক্ষমাণ',
    admin_note: n.admin_note || '',
    adminNote: n.admin_note || '',
  };
}

function genOrderId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KS-${t}-${r}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { ids, all, search } = req.query || {};

      if (all === '1' || all === 'true') {
        const user = await requireMerchant(req, res);
        if (!user) return;

        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) throw error;
        return res.status(200).json((data || []).map(mapOrder));
      }

      if (search) {
        const q = String(search).trim();
        if (!q) return res.status(200).json([]);
        const digits = q.replace(/\D/g, '');
        const phone = digits.startsWith('880') && digits.length === 13 ? `0${digits.slice(3)}` : digits;
        const isFullPhone = /^01[3-9][0-9]{8}$/.test(phone) && /^[+\d\s-]+$/.test(q);
        // Full order id format (genOrderId: KS-<base36>-<4chars>)
        const isFullOrderId = /^KS-[A-Z0-9]+-[A-Z0-9]+$/i.test(q);
        if (!isFullPhone && !isFullOrderId) {
          return res.status(200).json([]);
        }
        const column = isFullOrderId ? 'id' : 'phone';
        const value = isFullOrderId ? q.toUpperCase() : phone;
        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .eq(column, value)
          .order('created_at', { ascending: false })
          .limit(30);
        if (error) throw error;
        return res.status(200).json((data || []).map(mapOrder));
      }

      if (ids) {
        const idList = String(ids).split(',').map((s) => s.trim()).filter(Boolean);
        if (!idList.length) return res.status(200).json([]);
        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .in('id', idList);
        if (error) throw error;
        // Keep order of requested ids
        const byId = Object.fromEntries((data || []).map((o) => [o.id, mapOrder(o)]));
        return res.status(200).json(idList.map((id) => byId[id]).filter(Boolean));
      }

      return res.status(400).json({ error: 'Missing query' });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const customer = body.customer || {};
      const items = Array.isArray(body.items) ? body.items : [];
      const requestId = body.requestId ? String(body.requestId) : null;
      const expectedTotal = Number(body.expectedTotal ?? -1);

      if (!customer.name || !customer.phone || !customer.address) {
        return res.status(400).json({ error: 'নাম, ফোন ও ঠিকানা প্রয়োজন' });
      }
      if (!/^01[3-9][0-9]{8}$/.test(String(customer.phone).trim())) {
        return res.status(400).json({ error: 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)' });
      }
      if (!items.length) {
        return res.status(400).json({ error: 'ব্যাগ খালি' });
      }
      if (items.length > 100 || !['inside', 'outside'].includes(customer.region)) {
        return res.status(400).json({ error: 'অর্ডারের তথ্য সঠিক নয়' });
      }
      const uniqueLines = new Set();
      for (const item of items) {
        if (!item || typeof item.productId !== 'string' || typeof item.shadeId !== 'string') {
          return res.status(400).json({ error: 'পণ্যের তথ্য সঠিক নয়' });
        }
        const key = `${item.productId}:${item.shadeId}`;
        if (uniqueLines.has(key)) return res.status(400).json({ error: 'একই পণ্য একাধিকবার দেওয়া হয়েছে' });
        uniqueLines.add(key);
      }

      // Idempotency
      if (requestId) {
        const { data: existing } = await supabase
          .from('orders')
          .select('*')
          .eq('request_id', requestId)
          .maybeSingle();
        if (existing) return res.status(200).json(mapOrder(existing));
      }

      // Load products & settings
      const [{ data: products, error: pErr }, { data: settingsRow, error: sErr }] = await Promise.all([
        supabase.from('products').select('*'),
        supabase.from('settings').select('*').eq('id', 'main').maybeSingle(),
      ]);
      if (pErr) throw pErr;
      if (sErr) throw sErr;
      const settings = settingsRow || {};
      const byId = Object.fromEntries((products || []).map((p) => [p.id, p]));

      const couponCode = String(body.couponCode || '').trim().toUpperCase();
      let coupon = null;
      if (couponCode) {
        if (!/^[A-Z0-9_-]{2,32}$/.test(couponCode)) return res.status(400).json({ error: 'সঠিক কুপন কোড দিন' });
        const { data: found, error: couponError } = await supabase.from('coupons')
          .select('code,discount_percent,active,expires_at').eq('code', couponCode).maybeSingle();
        if (couponError) throw couponError;
        if (!found || !found.active || (found.expires_at && new Date(found.expires_at).getTime() <= Date.now())) {
          return res.status(400).json({ error: 'কুপনটি বৈধ নয় বা মেয়াদ শেষ' });
        }
        coupon = found;
      }

      const lineItems = [];
      const reservations = [];
      let subtotal = 0;
      let weight = 0;

      for (const cartItem of items) {
        const product = byId[cartItem.productId];
        if (!product || product.active === false) {
          return res.status(400).json({ error: 'কিছু পণ্য আর পাওয়া যাচ্ছে না' });
        }
        const qty = Number(cartItem.quantity);
        if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) {
          return res.status(400).json({ error: 'সঠিক পরিমাণ বেছে নিন' });
        }
        const shades = Array.isArray(product.shades) ? product.shades : [];
        let shade = null;
        let stock = Number(product.stock || 0);
        if (shades.length) {
          shade = shades.find((s) => s.id === cartItem.shadeId);
          if (!shade) return res.status(400).json({ error: `${product.name} এর শেড বেছে নিন` });
          stock = Number(shade.stock || 0);
        }
        if (qty > stock) {
          return res.status(400).json({ error: `${product.name}${shade ? ' · ' + shade.name : ''} স্টকে নেই` });
        }

        const price = Number(product.price || 0);
        const w = Number(product.weight || 0);
        if (!Number.isFinite(price) || price < 0 || !Number.isFinite(w) || w < 0) {
          return res.status(400).json({ error: 'পণ্যের মূল্য বা ওজন সঠিক নয়' });
        }
        lineItems.push({
          productId: product.id,
          name: product.name,
          shade: shade ? `${shade.name} · ${shade.code}` : '',
          shadeId: shade?.id || '',
          quantity: qty,
          price,
          weight: w,
          image: shade?.image || product.image || '',
        });
        subtotal += price * qty;
        weight += w * qty;
        reservations.push({ product, shade, qty, stock });
      }

      const region = customer.region === 'outside' ? 'outside' : 'inside';
      const delivery = calcDelivery(settings, weight, region, subtotal);
      const discount = coupon ? Math.round(subtotal * Number(coupon.discount_percent) / 100) : 0;
      const total = subtotal - discount + delivery;

      if (!Number.isFinite(expectedTotal) || Math.abs(expectedTotal - total) > 1) {
        return res.status(400).json({ error: 'মোট মূল্যে পরিবর্তন হয়েছে। পৃষ্ঠা রিফ্রেশ করে আবার চেষ্টা করুন।' });
      }

      const paymentLabel = String(customer.payment || 'ক্যাশ অন ডেলিভারি').slice(0, 80);
      const mobilePay = /বিকাশ|নগদ|রকেট|bkash|nagad|rocket/i.test(paymentLabel);
      let userNote = String(customer.note || '').slice(0, 400);
      if (mobilePay) {
        const trxMatch = userNote.match(/^TrxID: ([A-Z0-9]{8,15})(?:\n|$)/);
        if (!trxMatch) {
          return res.status(400).json({ error: 'ভুল বা অনুপস্থিত ট্রানজেকশন আইডি — অর্ডার নিশ্চিত করা যায়নি।' });
        }
      }
      const note = userNote
        ? `[পেমেন্ট: ${paymentLabel}]\n${userNote}`
        : `[পেমেন্ট: ${paymentLabel}]`;

      // Validate every order/payment field before changing stock. Existing JSONB
      // shade structure is preserved; a database transaction/RPC would be needed
      // to make cross-product reservations and order insert fully atomic.
      for (const { product, shade, qty, stock } of reservations) {
        if (shade) {
          const { data: fresh, error: freshErr } = await supabase
            .from('products').select('shades').eq('id', product.id).single();
          if (freshErr) throw freshErr;
          const freshShades = Array.isArray(fresh?.shades) ? fresh.shades : [];
          const freshShade = freshShades.find((s) => s.id === shade.id);
          const freshStock = Number(freshShade?.stock || 0);
          if (!freshShade || freshStock < qty) {
            return res.status(400).json({ error: `${product.name} · ${shade.name} স্টকে নেই` });
          }
          const newShades = freshShades.map((s) => s.id === shade.id ? { ...s, stock: freshStock - qty } : s);
          const { data: cas, error: casErr } = await supabase.from('products')
            .update({ shades: newShades, stock: 0 }).eq('id', product.id)
            .contains('shades', [freshShade]).select('id');
          if (casErr) throw casErr;
          if (!cas?.length) return res.status(400).json({ error: 'স্টক আপডেট ব্যর্থ — আবার চেষ্টা করুন' });
        } else {
          const { data: cas, error: casErr } = await supabase.from('products')
            .update({ stock: stock - qty }).eq('id', product.id)
            .eq('stock', stock).gte('stock', qty).select('id');
          if (casErr) throw casErr;
          if (!cas?.length) return res.status(400).json({ error: `${product.name} স্টকে নেই` });
        }
      }

      const order = {
        id: genOrderId(),
        request_id: requestId,
        name: String(customer.name).trim().slice(0, 120),
        phone: String(customer.phone).trim(),
        address: String(customer.address).trim(),
        region,
        note: coupon ? `${note}\n[কুপন: ${coupon.code}, ছাড়: ৳${discount}]` : note,
        items: lineItems,
        subtotal: subtotal - discount,
        weight,
        delivery,
        total,
        status: 'অপেক্ষমাণ',
        admin_note: '',
        created_at: new Date().toISOString(),
      };

      const { data, error } = await supabase.from('orders').insert(order).select().single();
      if (error) {
        // Retry without request_id collision
        if (String(error.message || '').includes('duplicate') && requestId) {
          const { data: again } = await supabase
            .from('orders')
            .select('*')
            .eq('request_id', requestId)
            .maybeSingle();
          if (again) return res.status(200).json(mapOrder(again));
        }
        throw error;
      }
      if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL && settings.email) {
        try {
          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: process.env.RESEND_FROM_EMAIL,
              to: [settings.email],
              subject: `নতুন অর্ডার ${data.id}`,
              text: `অর্ডার আইডি: ${data.id}\nকাস্টমার: ${data.name}\nফোন: ${data.phone}\nমোট: ৳${data.total}`,
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) console.error('Order email failed:', response.status, await response.text());
        } catch (mailError) {
          console.error('Order email failed:', mailError);
        }
      }
      return res.status(201).json(mapOrder(data));
    }

    if (req.method === 'PUT') {
      const user = await requireMerchant(req, res);
      if (!user) return;

      const { id, status, note } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id প্রয়োজন' });

      const { data, error } = await supabase
        .from('orders')
        .update({
          status: status || 'অপেক্ষমাণ',
          admin_note: note ?? '',
        })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json(mapOrder(data));
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('orders API error:', err);
    res.status(500).json({ error: err.message });
  }
}
