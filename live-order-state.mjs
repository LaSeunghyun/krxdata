const DEFAULT_STATUS = 'queued';

const escapeSql = (value) => String(value ?? '').replace(/'/g, "''");
const escapeJson = (value) => JSON.stringify(value).replace(/\$/g, '');

export function createOrderKey({ date, side, code, reason, sub, qty, slot }) {
  return [
    `date=${date ?? ''}`,
    `side=${side ?? ''}`,
    `code=${code ?? ''}`,
    `reason=${reason ?? ''}`,
    `sub=${sub ?? ''}`,
    `qty=${qty ?? ''}`,
    `slot=${slot ?? ''}`,
  ].join('|');
}

export function createOrderStateStore() {
  const rows = new Map();
  return {
    async claim(key, payload = {}) {
      if (rows.has(key)) return false;
      rows.set(key, { status: DEFAULT_STATUS, payload: structuredClone(payload) });
      return true;
    },
    async markSubmitted(key, payload = {}) {
      const row = rows.get(key);
      if (!row) return false;
      rows.set(key, { ...row, status: 'submitted', payload: { ...row.payload, ...structuredClone(payload) } });
      return true;
    },
    async markFilled(key, payload = {}) {
      const row = rows.get(key);
      if (!row) return false;
      rows.set(key, { ...row, status: 'filled', payload: { ...row.payload, ...structuredClone(payload) } });
      return true;
    },
    async markFailed(key, payload = {}) {
      const row = rows.get(key);
      if (!row) return false;
      rows.set(key, { ...row, status: 'failed', payload: { ...row.payload, ...structuredClone(payload) } });
      return true;
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
  };
}

export function createDbOrderStateStore({ dbQuery, tableName = 'paper_order_state' }) {
  if (typeof dbQuery !== 'function') throw new TypeError('dbQuery is required');

  const table = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const write = async (orderKey, status, payload = {}) => {
    const key = escapeSql(orderKey);
    const json = escapeJson(payload);
    await dbQuery(`
      INSERT INTO ${table} (order_key, status, payload, updated_at)
      VALUES ('${key}', '${escapeSql(status)}', $j$${json}$j$::jsonb, NOW())
      ON CONFLICT (order_key)
      DO UPDATE SET status = EXCLUDED.status, payload = ${table}.payload || EXCLUDED.payload, updated_at = NOW()
    `);
  };

  return {
    async claim(orderKey, payload = {}) {
      const key = escapeSql(orderKey);
      const json = escapeJson(payload);
      const rows = await dbQuery(`
        INSERT INTO ${table} (order_key, status, payload, updated_at)
        VALUES ('${key}', '${DEFAULT_STATUS}', $j$${json}$j$::jsonb, NOW())
        ON CONFLICT (order_key) DO NOTHING
        RETURNING order_key
      `);
      return Array.isArray(rows) && rows.length > 0;
    },
    async markSubmitted(orderKey, payload = {}) {
      return write(orderKey, 'submitted', payload);
    },
    async markFilled(orderKey, payload = {}) {
      return write(orderKey, 'filled', payload);
    },
    async markFailed(orderKey, payload = {}) {
      return write(orderKey, 'failed', payload);
    },
    async get(orderKey) {
      const rows = await dbQuery(`SELECT status, payload, updated_at FROM ${table} WHERE order_key = '${escapeSql(orderKey)}' LIMIT 1`);
      if (!Array.isArray(rows) || !rows.length) return null;
      const row = rows[0];
      return {
        status: row.status,
        payload: row.payload && typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        updatedAt: row.updated_at,
      };
    },
  };
}
