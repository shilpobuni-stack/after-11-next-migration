import supabase from './db-client.js';

/**
 * Verify Bearer token and check ADMIN_EMAILS, then the merchants table.
 * @returns {Promise<object|null>} Supabase user or null
 */
export async function requireMerchant(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }

  const email = (user.email || '').trim().toLowerCase();
  const allowed = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!email) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }

  if (!allowed.includes(email)) {
    const { data, error } = await supabase.from('merchants').select('email').eq('email', email).maybeSingle();
    if (error || !data) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
  }

  return user;
}
