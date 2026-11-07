/** Guarded localStorage/sessionStorage access, used everywhere instead of touching the APIs directly
 * (private browsing, blocked storage and quota errors must never crash the app). */
export const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
export const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
export const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); return true; } catch { return false; } };
export const ssDel = (k) => { try { sessionStorage.removeItem(k); } catch { /* blocked */ } };
export const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* blocked */ } };
