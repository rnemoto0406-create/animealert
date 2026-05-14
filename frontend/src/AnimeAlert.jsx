import { useState, useEffect, useCallback, useMemo } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function daysLeft(deadline) {
  if (!deadline) return null;
  const d = new Date(deadline);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((d - today) / 86400000);
}

function urgency(deadline) {
  const d = daysLeft(deadline);
  if (d === null) return 'none';
  if (d <= 4) return 'red';
  if (d <= 10) return 'amber';
  return 'green';
}

async function apiFetch(path, options = {}, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, options);
      const text = await res.text();
      // Guard against HTML error pages (Render cold-start 504, Vercel error page)
      if (text.trimStart().startsWith('<')) {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 8000 * (attempt + 1)));
          continue;
        }
        throw new Error('Server is waking up — please refresh in 30 seconds');
      }
      const data = JSON.parse(text);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      if (attempt < retries - 1 && err.name !== 'SyntaxError') {
        await new Promise(r => setTimeout(r, 8000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ── Auth Modal ──────────────────────────────────────────────────────────────
function AuthModal({ onClose, onLogin }) {
  const [tab, setTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [discord, setDiscord] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiFetch(`/auth/${tab}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (discord && tab === 'register') {
        await apiFetch('/user/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
          body: JSON.stringify({ notify_discord: discord }),
        }).catch(() => {});
      }
      onLogin(data.token, data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="btn-close" onClick={onClose} aria-label="Close">×</button>
        <h2>Account</h2>
        <div className="tabs">
          {['login', 'register'].map(t => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'login' ? 'Login' : 'Register'}
            </button>
          ))}
        </div>
        <form onSubmit={submit}>
          <input type="email" placeholder="Email" value={email}
            onChange={e => setEmail(e.target.value)} required maxLength={255} autoComplete="email" />
          <input type="password" placeholder="Password (min 8 chars)" value={password}
            onChange={e => setPassword(e.target.value)} required minLength={8} maxLength={128} autoComplete={tab === 'login' ? 'current-password' : 'new-password'} />
          {tab === 'register' && (
            <input type="url" placeholder="Discord Webhook URL (optional)"
              value={discord} onChange={e => setDiscord(e.target.value)} maxLength={500} />
          )}
          {error && <p className="msg-error">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading…' : tab === 'login' ? 'Login' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Settings Modal ──────────────────────────────────────────────────────────
function SettingsModal({ user, token, onClose, onSaved }) {
  const [notifyEmail, setNotifyEmail] = useState(user?.notify_email || '');
  const [notifyDiscord, setNotifyDiscord] = useState(user?.notify_discord || '');
  const [notifyDays, setNotifyDays] = useState(user?.notify_days_before ?? 3);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/user/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          notify_email: notifyEmail || undefined,
          notify_discord: notifyDiscord || undefined,
          notify_days_before: notifyDays,
        }),
      });
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="btn-close" onClick={onClose} aria-label="Close">×</button>
        <h2>Notification Settings</h2>
        <form onSubmit={save}>
          <label htmlFor="s-email">Alert Email</label>
          <input id="s-email" type="email" value={notifyEmail}
            onChange={e => setNotifyEmail(e.target.value)} maxLength={255} placeholder="you@example.com" />
          <label htmlFor="s-discord">Discord Webhook URL</label>
          <input id="s-discord" type="url" value={notifyDiscord}
            onChange={e => setNotifyDiscord(e.target.value)} maxLength={500}
            placeholder="https://discord.com/api/webhooks/…" />
          <label htmlFor="s-days">Alert {notifyDays} day(s) before deadline</label>
          <input id="s-days" type="range" min={1} max={30} value={notifyDays}
            onChange={e => setNotifyDays(Number(e.target.value))} />
          {error && <p className="msg-error">{error}</p>}
          {saved && <p className="msg-success">Settings saved!</p>}
          <button type="submit" className="btn btn-primary">Save</button>
        </form>
      </div>
    </div>
  );
}

// ── Product Card ────────────────────────────────────────────────────────────
function ProductCard({ product, saved, onSave, onRemove }) {
  const u = urgency(product.deadline);
  const d = daysLeft(product.deadline);

  return (
    <article className={`card card-${u}`}>
      {product.imageUrl && (
        <img src={product.imageUrl} alt={product.name} className="card-img" loading="lazy" />
      )}
      <div className="card-body">
        <p className="card-name">{product.name}</p>
        <div className="card-meta">
          {product.category && <span className="tag">{product.category}</span>}
          <span className={`badge badge-${u}`}>
            {d !== null ? `${d}d left` : 'No deadline'}
          </span>
          <span className="badge badge-src">{product.source}</span>
        </div>
        {product.price && <p className="card-price">{product.price}</p>}
        {product.deadline && <p className="card-deadline">Deadline: {product.deadline}</p>}
        <div className="card-actions">
          {saved
            ? <button className="btn btn-danger" onClick={() => onRemove(product.key)}>Remove</button>
            : <button className="btn btn-primary" onClick={() => onSave(product)}>Save</button>
          }
          {product.productUrl && (
            <a href={product.productUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
              View ↗
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────
export default function AnimeAlert() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [search, setSearch] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterType, setFilterType] = useState('');
  const [token, setToken] = useState(() => localStorage.getItem('aa_token'));
  const [user, setUser] = useState(null);
  const [watchlistKeys, setWatchlistKeys] = useState([]);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showWatchlist, setShowWatchlist] = useState(false);

  // Load products (with cold-start retry)
  const loadProducts = useCallback(() => {
    setLoading(true);
    setFetchError('');
    setRetrying(false);
    const controller = new AbortController();
    // Show "retrying" message after first 5s
    const hint = setTimeout(() => setRetrying(true), 5000);
    apiFetch('/products', { signal: controller.signal })
      .then(data => { setProducts(data); setRetrying(false); })
      .catch(e => { if (e.name !== 'AbortError') setFetchError(e.message); })
      .finally(() => { clearTimeout(hint); setLoading(false); });
    return () => { controller.abort(); clearTimeout(hint); };
  }, []);

  useEffect(() => { return loadProducts(); }, [loadProducts]);

  // Load user + watchlist when token changes
  useEffect(() => {
    if (!token) { setUser(null); setWatchlistKeys([]); return; }
    apiFetch('/user/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(setUser)
      .catch(() => { setToken(null); localStorage.removeItem('aa_token'); });
    apiFetch('/user/watchlist', { headers: { Authorization: `Bearer ${token}` } })
      .then(items => setWatchlistKeys(items.map(i => i.item_key)))
      .catch(() => {});
  }, [token]);

  const handleLogin = useCallback((tok, u) => {
    localStorage.setItem('aa_token', tok);
    setToken(tok);
    setUser(u);
    setShowAuth(false);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('aa_token');
    setToken(null);
    setUser(null);
    setWatchlistKeys([]);
    setShowWatchlist(false);
  }, []);

  const handleSave = useCallback(async (product) => {
    if (!token) { setShowAuth(true); return; }
    await apiFetch('/user/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        item_key: product.key,
        item_name: product.name,
        item_source: product.source,
        item_deadline: product.deadline,
      }),
    }).catch(() => {});
    setWatchlistKeys(prev => [...new Set([...prev, product.key])]);
  }, [token]);

  const handleRemove = useCallback(async (key) => {
    await apiFetch(`/user/watchlist/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    setWatchlistKeys(prev => prev.filter(k => k !== key));
  }, [token]);

  const refreshUser = useCallback(() => {
    if (!token) return;
    apiFetch('/user/me', { headers: { Authorization: `Bearer ${token}` } }).then(setUser).catch(() => {});
  }, [token]);

  // Filtered + grouped products
  const filtered = useMemo(() => {
    let r = products;
    if (filterSource) r = r.filter(p => p.source === filterSource || p.sources?.includes(filterSource));
    if (filterType) { const q = filterType.toLowerCase(); r = r.filter(p => p.category?.toLowerCase().includes(q)); }
    if (search) { const q = search.toLowerCase(); r = r.filter(p => p.name.toLowerCase().includes(q)); }
    return r;
  }, [products, filterSource, filterType, search]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const p of filtered) {
      const k = p.deadline || 'No Deadline';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    return [...map.entries()].sort(([a], [b]) => {
      if (a === 'No Deadline') return 1;
      if (b === 'No Deadline') return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  const watchlistProducts = useMemo(() =>
    products.filter(p => watchlistKeys.includes(p.key)), [products, watchlistKeys]);

  return (
    <div className="app">
      <header className="header">
        <h1 className="logo">AnimeAlert</h1>
        <nav className="nav">
          {token ? (
            <>
              <button className="btn btn-ghost" onClick={() => setShowWatchlist(v => !v)}>
                Watchlist {watchlistKeys.length > 0 && <span className="pill">{watchlistKeys.length}</span>}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowSettings(true)}>Settings</button>
              <button className="btn btn-secondary" onClick={handleLogout}>Logout</button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => setShowAuth(true)}>Login / Register</button>
          )}
        </nav>
      </header>

      <div className="filters">
        <input type="search" placeholder="Search products…" value={search}
          onChange={e => setSearch(e.target.value.slice(0, 100))} maxLength={100} className="filter-input" />
        <select value={filterSource} onChange={e => setFilterSource(e.target.value)} className="filter-select">
          <option value="">All Sources</option>
          <option value="GoodSmile">GoodSmile</option>
          <option value="AmiAmi">AmiAmi</option>
        </select>
        <input type="text" placeholder="Type (Figure, Plush…)" value={filterType}
          onChange={e => setFilterType(e.target.value.slice(0, 50))} maxLength={50} className="filter-input" />
      </div>

      {showWatchlist && watchlistKeys.length > 0 && (
        <section className="watchlist-panel">
          <h2>Your Watchlist</h2>
          <div className="grid">
            {watchlistProducts.map(p => (
              <ProductCard key={p.key} product={p} saved onSave={handleSave} onRemove={handleRemove} />
            ))}
          </div>
        </section>
      )}
      {showWatchlist && watchlistKeys.length === 0 && (
        <p className="empty">Your watchlist is empty. Save items to track their deadlines.</p>
      )}

      {loading && (
        <div className="cold-start">
          <p className="empty">{retrying ? '⏳ Server is waking up… retrying automatically (up to 30s)' : 'Loading products…'}</p>
          {retrying && <p className="empty" style={{fontSize:'0.8rem'}}>Render free tier sleeps after 15 min of inactivity.</p>}
        </div>
      )}
      {fetchError && (
        <div className="cold-start">
          <p className="msg-error center">{fetchError}</p>
          <button className="btn btn-primary" style={{margin:'0.75rem auto',display:'block'}} onClick={loadProducts}>
            Retry
          </button>
          {fetchError.includes('waking') && (
            <p className="empty" style={{fontSize:'0.8rem'}}>
              Render free tier can take up to 50s to start. Click Retry or wait a moment and refresh.
            </p>
          )}
        </div>
      )}

      {!loading && !fetchError && groups.length === 0 && (
        <p className="empty">No products found{search || filterSource || filterType ? ' matching your filters' : ''}.</p>
      )}

      {!loading && groups.map(([deadline, items]) => {
        const u = urgency(deadline !== 'No Deadline' ? deadline : null);
        const d = daysLeft(deadline !== 'No Deadline' ? deadline : null);
        return (
          <section key={deadline} className="group">
            <h2 className={`group-heading heading-${u}`}>
              {deadline}
              {d !== null && <span className={`badge badge-${u}`}>{d}d left</span>}
            </h2>
            <div className="grid">
              {items.map(p => (
                <ProductCard key={p.key} product={p}
                  saved={watchlistKeys.includes(p.key)}
                  onSave={handleSave} onRemove={handleRemove} />
              ))}
            </div>
          </section>
        );
      })}

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onLogin={handleLogin} />}
      {showSettings && user && (
        <SettingsModal user={user} token={token}
          onClose={() => setShowSettings(false)} onSaved={refreshUser} />
      )}
    </div>
  );
}
