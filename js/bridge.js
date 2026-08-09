/**
 * Bridge.js — FarmConnect ⇄ Thulir marketplace bridge
 * ─────────────────────────────────────────────────────────────────
 *
 * FarmConnect is a standalone consumer/farmer app with its own localStorage data — it has no
 * knowledge of Thulir, the Tamil Nadu farm-advisor app. Thulir's server already exposes a
 * marketplace bridge API expecting exactly this shape of traffic (see its
 * `server/src/routes/marketplaceRoutes.ts`):
 *
 *   OUTBOUND (this app → Thulir):
 *     Every consumer request/order placed here is synced to Thulir via
 *     POST /api/marketplace/orders/sync — this is what lets a Thulir farmer ask
 *     "what's the demand for my crop?" and get a REAL answer instead of nothing.
 *
 *   INBOUND (Thulir → this app):
 *     When a Thulir farmer says "let's sell it", Thulir POSTs a listing to its own
 *     /api/marketplace/listings. This bridge polls Thulir's /api/marketplace/listings/new
 *     and turns each new listing into a FarmConnect product + a notification for every
 *     registered consumer — the same effect as a local farmer's "🚀 Push Availability",
 *     just sourced from Thulir's farmer network instead of a farmer registered here.
 *
 * All exchanges are logged to the console (same transparency convention as agent.js's
 * REQUEST/RESPONSE/PUSH logging) and every network call degrades silently on failure —
 * this bridge is advisory, never something the rest of the app depends on to function.
 * ─────────────────────────────────────────────────────────────────
 */
const Bridge = {

  // ── Configuration ──────────────────────────────────────────────
  // Thulir's deployed API origin (Cloud Run service URL), e.g. "https://thulir-xxxxx-uc.a.run.app".
  // Leave blank to disable the bridge entirely (it then no-ops with a console warning) — this
  // MUST be set to the real deployed Thulir URL before this app goes live, since FarmConnect and
  // Thulir are two independently-deployed services with no shared origin.
  THULIR_API_BASE: '',

  POLL_INTERVAL_MS: 20 * 1000,
  MAX_PROCESSED_IDS: 200,

  KEYS: {
    LAST_POLL: 'fc_thulir_last_poll',
    PROCESSED_IDS: 'fc_thulir_processed_ids'
  },

  _pollTimer: null,

  // ── Bootstrap ──────────────────────────────────────────────────

  init() {
    if (!this.THULIR_API_BASE) {
      console.warn('[Bridge] THULIR_API_BASE is not set — Thulir marketplace bridge disabled. Set Bridge.THULIR_API_BASE in js/bridge.js to enable it.');
      return;
    }
    // First poll shortly after boot (let Store.seed() finish first), then on an interval.
    setTimeout(() => this.pollListings(), 2000);
    this._pollTimer = setInterval(() => this.pollListings(), this.POLL_INTERVAL_MS);
  },

  // ── Outbound: consumer order → Thulir ─────────────────────────

  /**
   * Syncs one FarmConnect order to Thulir's demand tracker. Fire-and-forget — call this right
   * after Store.addOrder(); never awaited by the caller, never throws.
   * @param {Object} order  The order object returned by Store.addOrder()
   */
  async syncOrder(order) {
    if (!this.THULIR_API_BASE || !order) return;

    const payload = {
      externalId: order.id,
      productName: order.productName,
      quantity: order.requestedQty,
      unit: order.unit || 'piece',
      price: typeof order.price === 'number' ? order.price : null,
      requestedAt: order.createdAt,
      consumerId: order.consumerId || undefined,
      consumerName: order.consumerName || undefined,
      region: (order.consumerLocation && order.consumerLocation.label) || undefined
    };

    try {
      console.log('%c[Bridge] → syncing order to Thulir', 'color:#2D7A4F;font-weight:bold', payload);
      const res = await fetch(`${this.THULIR_API_BASE}/api/marketplace/orders/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: [payload] })
      });
      if (!res.ok) {
        console.warn('[Bridge] Thulir rejected order sync:', res.status);
      }
    } catch (err) {
      // Network failure, Thulir unreachable, etc. — never blocks the consumer's own order flow.
      console.warn('[Bridge] Could not reach Thulir to sync order:', err.message);
    }
  },

  // ── Inbound: Thulir listing → FarmConnect product + notification ─

  _getLastPollTs() {
    const raw = localStorage.getItem(this.KEYS.LAST_POLL);
    return raw ? Number(raw) : 0;
  },

  _setLastPollTs(ts) {
    localStorage.setItem(this.KEYS.LAST_POLL, String(ts));
  },

  _getProcessedIds() {
    try {
      return JSON.parse(localStorage.getItem(this.KEYS.PROCESSED_IDS)) || [];
    } catch {
      return [];
    }
  },

  _markProcessed(id) {
    const ids = this._getProcessedIds();
    if (ids.includes(id)) return;
    ids.push(id);
    while (ids.length > this.MAX_PROCESSED_IDS) ids.shift();
    localStorage.setItem(this.KEYS.PROCESSED_IDS, JSON.stringify(ids));
  },

  async pollListings() {
    if (!this.THULIR_API_BASE) return;
    const since = this._getLastPollTs();

    try {
      const res = await fetch(`${this.THULIR_API_BASE}/api/marketplace/listings/new?since=${since}`);
      if (!res.ok) return;
      const body = await res.json();
      const listings = Array.isArray(body.listings) ? body.listings : [];
      if (listings.length === 0) return;

      const processedIds = this._getProcessedIds();
      const fresh = listings.filter(l => !processedIds.includes(l.id));
      if (fresh.length === 0) return;

      console.log(`%c[Bridge] ← ${fresh.length} new listing(s) from Thulir`, 'color:#2563EB;font-weight:bold', fresh);
      fresh.forEach(listing => {
        this._ingestListing(listing);
        this._markProcessed(listing.id);
      });

      const latest = Math.max(since, ...listings.map(l => l.createdAt || 0));
      this._setLastPollTs(latest);

      if (typeof NotificationSystem !== 'undefined') NotificationSystem.updateBadge();
    } catch (err) {
      console.warn('[Bridge] Could not reach Thulir to poll listings:', err.message);
    }
  },

  /**
   * Turns one Thulir listing into a FarmConnect product (grouped under a stable synthetic
   * "farmer" per distinct Thulir farmer name, so repeat listings don't create duplicates) and
   * notifies every registered consumer — the same end effect as Agent.pushAvailability(), just
   * for a farmer that lives in Thulir's network rather than one registered in this app.
   *
   * Deliberately NOT reusing Agent.pushAvailability() directly: it requires a farmer.location
   * with lat/lng to compute a 3km radius, which Thulir listings don't carry (only a free-text
   * region label) — so this notifies every consumer rather than filtering by distance, and the
   * product renders via consumer.view.js's own existing "no location → treat as nearby" fallback.
   */
  _ingestListing(listing) {
    const farmerName = listing.farmerName || 'A Thulir farmer';
    const farmerId = `thulir-${this._slug(farmerName)}`;

    let farmer = Store.getUserById(farmerId);
    if (!farmer) {
      // Store.addUser() de-dupes on phone+role, so every synthetic Thulir farmer needs its own
      // distinct (fake) phone value — a shared blank phone would make addUser() silently reject
      // every Thulir farmer after the first one.
      farmer = Store.addUser({
        id: farmerId,
        name: farmerName,
        phone: farmerId,
        role: 'farmer',
        location: null,
        specialties: [listing.cropName],
        farmType: 'thulir-network',
        rating: 4.5,
        emoji: '🌾',
        available: true,
        source: 'thulir'
      });
    }

    const guide = (typeof Agent !== 'undefined') ? Agent._getGuide(listing.cropName) : { category: 'Vegetables', emoji: '🌾' };

    let product = Store.getProductsByFarmer(farmerId).find(p => p.name.toLowerCase() === listing.cropName.toLowerCase());
    const productData = {
      farmerId,
      farmerName,
      name: listing.cropName,
      category: guide.category,
      quantity: listing.quantity,
      unit: listing.unit,
      price: listing.price,
      location: null, // no precise geo from Thulir — renders via the existing "fallback to consumer's own location" path
      emoji: guide.emoji,
      source: 'thulir',
      farmerPushed: true,
      region: listing.region || null,
      pushedAt: Date.now()
    };

    if (product) {
      product = Store.updateProduct(product.id, productData);
    } else {
      product = Store.addProduct(productData);
    }

    const consumers = Store.getUsers().filter(u => u.role === 'consumer');
    const regionNote = listing.region ? ` (${listing.region})` : '';
    consumers.forEach(consumer => {
      Store.addNotification({
        userId: consumer.id,
        message: `🌐 ${farmerName}${regionNote} just listed ${listing.cropName} on the Thulir network — ₹${listing.price}/${listing.unit}. Tap to view.`,
        type: 'push',
        orderId: null,
        extra: { productId: product.id, farmerId }
      });
    });
  },

  _slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'farmer';
  }
};

document.addEventListener('DOMContentLoaded', () => Bridge.init());
