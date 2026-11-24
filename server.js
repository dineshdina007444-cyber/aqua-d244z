'use strict';
/**
 * Aqua World – Aquarium Shop backend
 * Node.js + Express + MongoDB (Mongoose)
 */
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const {
  MONGODB_URI = 'mongodb://127.0.0.1:27017/aquaworld',
  JWT_SECRET, ADMIN_ID, ADMIN_PASSWORD, PORT = 3000,
} = process.env;
const LOW_STOCK = Number(process.env.LOW_STOCK) || 5;

if (!JWT_SECRET || JWT_SECRET.length < 16 || !ADMIN_ID || !ADMIN_PASSWORD) {
  console.error('\n.env file missing or incomplete. Copy .env.example to .env and set JWT_SECRET (16+ chars), ADMIN_ID and ADMIN_PASSWORD.\n');
  process.exit(1);
}

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const rx = s => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const needId = id => { if (!mongoose.isValidObjectId(id)) bad('Invalid id'); return id; };
const okImg = v => typeof v === 'string' && (
  (v.length <= 16) || (v.length <= 1_500_000 && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(v)));
const img = (v, fallback = '') => { if (v === undefined || v === '') return fallback; if (!okImg(v)) bad('Invalid image'); return v; };
const link = v => { v = str(v, 300); if (v && !/^https?:\/\//i.test(v)) bad('Links must start with https://'); return v; };

/* ---------- models ---------- */
mongoose.set('toJSON', { transform: (d, r) => { r.id = String(r._id); delete r._id; delete r.__v; return r; } });
const S = mongoose.Schema;
const Shop = mongoose.model('Shop', new S({ name: String, logo: String, phone: String, wa: String, email: String, addr: String, ig: String, fb: String, yt: String }));
const Category = mongoose.model('Category', new S({ name: { type: String, required: true }, img: String }, { timestamps: true }));
const Product = mongoose.model('Product', new S({
  name: { type: String, required: true, index: true }, cat: { type: String, index: true },
  mrp: Number, price: Number, pmrp: Number, pprice: Number,
  single: Boolean, pair: Boolean, stock: { type: Number, min: 0, default: 0 }, avail: { type: Boolean, default: true },
  desc: String, img: String,
}, { timestamps: true }));
const Banner = mongoose.model('Banner', new S({ title: String, text: String, img: String, order: { type: Number, default: 0 } }));
const Offer = mongoose.model('Offer', new S({ title: String, text: String }));
const QR = mongoose.model('QR', new S({ method: { type: String, unique: true }, img: String }));
const Customer = mongoose.model('Customer', new S({ name: String, mobile: { type: String, unique: true }, lastLogin: Date }, { timestamps: true }));

const STATUSES = ['New Order', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const METHODS = ['COD', 'PhonePe', 'GPay', 'Paytm'];
const itemSchema = new S({ productId: String, name: String, opt: String, qty: Number, mrp: Number, price: Number }, { _id: false });
const Order = mongoose.model('Order', new S({
  orderId: { type: String, unique: true, index: true },
  customerMobile: { type: String, index: true },
  name: String, mobile: { type: String, index: true }, addr: String, city: String, state: String, pin: String,
  items: [itemSchema], sub: Number, disc: Number, total: Number,
  method: String, status: { type: String, default: 'New Order', index: true },
  pay: String, utr: String, date: { type: Date, default: Date.now, index: true },
}, {
  toJSON: { transform: (d, r) => { r.id = r.orderId; delete r._id; delete r.__v; delete r.orderId; delete r.customerMobile; return r; } },
}));

/* ---------- stock handling (atomic per product) ---------- */
// Takes stock for every line, or nothing at all.
async function reserve(lines, requireAvail) {
  const done = [];
  for (const l of lines) {
    const f = { _id: l.productId, stock: { $gte: l.qty } };
    if (requireAvail) f.avail = true;
    const p = await Product.findOneAndUpdate(f, { $inc: { stock: -l.qty } });
    if (!p) { await release(done); return l.name || 'Item'; }
    done.push(l);
  }
  return null;
}
const release = lines => Promise.all(lines.map(l =>
  mongoose.isValidObjectId(l.productId) ? Product.updateOne({ _id: l.productId }, { $inc: { stock: l.qty } }) : null));

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sign = (p, exp) => jwt.sign(p, JWT_SECRET, { expiresIn: exp });
const auth = role => (req, res, next) => {
  const h = req.headers.authorization || '';
  try {
    const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
    if (p.role !== role) throw new Error('role');
    req.auth = p; next();
  } catch (e) { res.status(401).json({ error: 'Please sign in again.' }); }
};
const admin = auth('admin'), customer = auth('customer');
const limiter = (max, windowMin = 15) => rateLimit({ windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again later.' } });
const h256 = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(h256(a), h256(b));

/* ===== public ===== */
app.get('/api/bootstrap', wrap(async (req, res) => {
  const [shop, cats, prods, banners, offers, qrs] = await Promise.all([
    Shop.findOne(), Category.find().sort({ _id: 1 }), Product.find().sort({ createdAt: -1, _id: -1 }),
    Banner.find().sort({ order: 1, _id: 1 }), Offer.find().sort({ _id: 1 }), QR.find(),
  ]);
  const qr = {}; qrs.forEach(q => { qr[q.method] = q.img; });
  res.json({ shop: shop || {}, cats, prods, banners, offers, qr, lowStock: LOW_STOCK });
}));

app.post('/api/customers/login', limiter(30), wrap(async (req, res) => {
  const name = str(req.body.name, 60), mobile = str(req.body.mobile, 10);
  if (name.length < 2) bad('Enter your name (at least 2 letters).');
  if (!/^[6-9]\d{9}$/.test(mobile)) bad('Enter a valid 10-digit Indian mobile number.');
  await Customer.findOneAndUpdate({ mobile }, { $set: { name, lastLogin: new Date() } }, { upsert: true });
  res.json({ name, mobile, token: sign({ role: 'customer', mobile }, '30d') });
}));

app.post('/api/orders', customer, limiter(40), wrap(async (req, res) => {
  const b = req.body;
  const d = { name: str(b.name, 60), mobile: str(b.mobile, 10), addr: str(b.addr, 300), city: str(b.city, 60), state: str(b.state, 60), pin: str(b.pin, 6) };
  if (d.name.length < 2) bad('Enter your name.');
  if (!/^[6-9]\d{9}$/.test(d.mobile)) bad('Enter a valid 10-digit mobile number.');
  if (d.addr.length < 10) bad('Enter your full address (at least 10 characters).');
  if (d.city.length < 2) bad('Enter your city.');
  if (d.state.length < 2) bad('Enter your state.');
  if (!/^\d{6}$/.test(d.pin)) bad('Enter a 6-digit PIN code.');
  const method = str(b.method, 10);
  if (!METHODS.includes(method)) bad('Choose a payment method.');
  let utr = '';
  if (method !== 'COD') {
    if (!(await QR.exists({ method }))) bad('This QR is not available. Choose another method.');
    utr = str(b.utr, 30);
    if (!/^[A-Za-z0-9]{6,30}$/.test(utr)) bad('Enter your payment reference (6–30 letters or digits).');
  }
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) bad('Your cart is empty.');

  // merge duplicate lines, validate
  const want = new Map();
  for (const i of b.items) {
    const opt = i.opt === 'P' ? 'P' : 'S', qty = Math.floor(Number(i.qty));
    if (!mongoose.isValidObjectId(i.pid) || !(qty >= 1 && qty <= 100)) bad('Invalid cart item.');
    const k = i.pid + opt; const w = want.get(k) || { pid: String(i.pid), opt, qty: 0 };
    w.qty += qty; want.set(k, w);
  }
  const prods = await Product.find({ _id: { $in: [...new Set([...want.values()].map(w => w.pid))] } });
  const byId = new Map(prods.map(p => [String(p._id), p]));
  const items = [];
  for (const w of want.values()) {
    const p = byId.get(w.pid);
    if (!p) bad('A product in your cart is no longer available. Update your cart.', 409);
    if (!p.avail || p.stock <= 0) bad(`${p.name} is out of stock. Update your cart.`, 409);
    if ((w.opt === 'P' && !p.pair) || (w.opt === 'S' && !p.single)) bad(`${p.name}: this option is not available.`, 409);
    // prices always come from the database, never from the browser
    items.push({ productId: w.pid, name: p.name, opt: w.opt, qty: w.qty, mrp: w.opt === 'P' ? p.pmrp : p.mrp, price: w.opt === 'P' ? p.pprice : p.price });
  }
  const short = await reserve(items, true);
  if (short) bad(`${short} is out of stock. Update your cart.`, 409);

  const sub = items.reduce((a, i) => a + i.mrp * i.qty, 0), total = items.reduce((a, i) => a + i.price * i.qty, 0);
  try {
    const order = await Order.create({
      orderId: 'AQ' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
      customerMobile: req.auth.mobile, ...d, items, sub, disc: sub - total, total, method,
      status: 'New Order', pay: method === 'COD' ? 'Pay on Delivery' : 'Payment Pending (unverified)', utr,
    });
    res.status(201).json(order);
  } catch (e) { await release(items); throw e; }
}));

app.get('/api/my-orders', customer, wrap(async (req, res) => {
  res.json(await Order.find({ customerMobile: req.auth.mobile }).sort({ date: -1 }).limit(200));
}));

/* ===== admin ===== */
app.post('/api/admin/login', limiter(10), wrap(async (req, res) => {
  const ok = same(str(req.body.id, 100), ADMIN_ID) & same(str(req.body.password, 200), ADMIN_PASSWORD);
  if (!ok) bad('Wrong admin ID or password.', 401);
  res.json({ token: sign({ role: 'admin' }, '12h') });
}));

app.get('/api/admin/stats', admin, wrap(async (req, res) => {
  const [products, orders, customers, rev, pending, completed, outOfStock, lowStock] = await Promise.all([
    Product.countDocuments(), Order.countDocuments(), Customer.countDocuments(),
    Order.aggregate([{ $match: { status: { $ne: 'Cancelled' } } }, { $group: { _id: null, t: { $sum: '$total' } } }]),
    Order.countDocuments({ status: { $nin: ['Delivered', 'Cancelled'] } }), Order.countDocuments({ status: 'Delivered' }),
    Product.countDocuments({ $or: [{ avail: false }, { stock: { $lte: 0 } }] }),
    Product.countDocuments({ avail: true, stock: { $gt: 0, $lte: LOW_STOCK } }),
  ]);
  res.json({ products, orders, customers, revenue: rev[0] ? rev[0].t : 0, pending, completed, outOfStock, lowStock });
}));

app.get('/api/admin/orders', admin, wrap(async (req, res) => {
  const f = {};
  if (STATUSES.includes(req.query.status)) f.status = req.query.status;
  const q = str(req.query.q, 60);
  if (q) { const r = rx(q); f.$or = [{ orderId: r }, { name: r }, { mobile: r }]; }
  res.json(await Order.find(f).sort({ date: -1 }).limit(500));
}));

app.patch('/api/admin/orders/:id/status', admin, wrap(async (req, res) => {
  const s = str(req.body.status, 20);
  if (!STATUSES.includes(s)) bad('Invalid status');
  const o = await Order.findOne({ orderId: str(req.params.id, 40) });
  if (!o) bad('Order not found', 404);
  if (o.status === s) return res.json(o);
  if (s === 'Cancelled') {                       // cancelled -> stock goes back
    const u = await Order.findOneAndUpdate({ _id: o._id, status: { $ne: 'Cancelled' } }, { status: s }, { new: true });
    if (u) await release(u.items);
    return res.json(u || o);
  }
  if (o.status === 'Cancelled') {                // re-opening -> take stock again
    const short = await reserve(o.items, false);
    if (short) bad(`Not enough stock of ${short} to re-open this order.`, 409);
    const u = await Order.findOneAndUpdate({ _id: o._id, status: 'Cancelled' }, { status: s }, { new: true });
    if (!u) { await release(o.items); return res.json(await Order.findById(o._id)); }
    return res.json(u);
  }
  o.status = s; await o.save(); res.json(o);
}));

app.patch('/api/admin/orders/:id/paid', admin, wrap(async (req, res) => {
  const o = await Order.findOneAndUpdate({ orderId: str(req.params.id, 40) }, { pay: 'Paid (confirmed by shop)' }, { new: true });
  if (!o) bad('Order not found', 404);
  res.json(o);
}));

app.get('/api/admin/customers', admin, wrap(async (req, res) => {
  const q = str(req.query.q, 60), m = q ? [{ $match: { $or: [{ name: rx(q) }, { mobile: rx(q) }] } }] : [];
  res.json(await Order.aggregate([...m, { $sort: { date: -1 } }, { $group: {
    _id: '$mobile', name: { $first: '$name' }, mobile: { $first: '$mobile' }, addr: { $first: '$addr' }, city: { $first: '$city' }, pin: { $first: '$pin' },
    n: { $sum: 1 }, amt: { $sum: { $cond: [{ $eq: ['$status', 'Cancelled'] }, 0, '$total'] } } } }, { $project: { _id: 0 } }, { $sort: { n: -1 } }]));
}));

/* products */
function prodBody(b, partialImg) {
  const name = str(b.name, 100), mrp = Number(b.mrp), price = Number(b.price);
  const pmrp = Number(b.pmrp) || mrp * 2, pprice = Number(b.pprice) || price * 2;
  if (name.length < 2) bad('Enter a product name.');
  if (!(mrp > 0 && price > 0)) bad('Enter the original and offer price.');
  if (price > mrp) bad('Offer price cannot be higher than the original price.');
  if (pprice > pmrp) bad('Pair offer price cannot be higher than the pair original price.');
  if (!b.single && !b.pair) bad('Enable Single or Pair.');
  const data = { name, cat: str(b.cat, 40), mrp, price, pmrp, pprice, single: !!b.single, pair: !!b.pair,
    stock: Math.max(0, Math.floor(Number(b.stock)) || 0), avail: !!b.avail, desc: str(b.desc, 1000) };
  if (b.img !== undefined || !partialImg) data.img = img(b.img, '🐟');
  return data;
}
app.post('/api/admin/products', admin, wrap(async (req, res) => {
  const data = prodBody(req.body, false);
  if (!(await Category.exists({ _id: needId(data.cat) }))) bad('Choose a valid category.');
  res.status(201).json(await Product.create(data));
}));
app.put('/api/admin/products/:id', admin, wrap(async (req, res) => {
  const data = prodBody(req.body, true);
  if (!(await Category.exists({ _id: needId(data.cat) }))) bad('Choose a valid category.');
  const p = await Product.findByIdAndUpdate(needId(req.params.id), { $set: data }, { new: true });
  if (!p) bad('Product not found', 404);
  res.json(p);
}));
app.delete('/api/admin/products/:id', admin, wrap(async (req, res) => {
  await Product.deleteOne({ _id: needId(req.params.id) }); res.json({ ok: true });
}));

/* categories */
app.post('/api/admin/categories', admin, wrap(async (req, res) => {
  const name = str(req.body.name, 60); if (!name) bad('Enter a category name');
  res.status(201).json(await Category.create({ name, img: img(req.body.img, '🐟') }));
}));
app.put('/api/admin/categories/:id', admin, wrap(async (req, res) => {
  const name = str(req.body.name, 60); if (!name) bad('Enter a category name');
  const c = await Category.findByIdAndUpdate(needId(req.params.id), { name }, { new: true });
  if (!c) bad('Category not found', 404); res.json(c);
}));
app.delete('/api/admin/categories/:id', admin, wrap(async (req, res) => {
  const id = needId(req.params.id);
  if (await Product.exists({ cat: id })) bad('Move or delete this category’s products first');
  await Category.deleteOne({ _id: id }); res.json({ ok: true });
}));

/* banners */
app.post('/api/admin/banners', admin, wrap(async (req, res) => {
  const title = str(req.body.title, 100); if (!title) bad('Enter an offer title');
  res.status(201).json(await Banner.create({ title, text: str(req.body.text, 200), img: img(req.body.img), order: await Banner.countDocuments() }));
}));
app.put('/api/admin/banners/reorder', admin, wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(needId) : bad('Invalid order');
  await Promise.all(ids.map((id, i) => Banner.updateOne({ _id: id }, { order: i }))); res.json({ ok: true });
}));
app.put('/api/admin/banners/:id', admin, wrap(async (req, res) => {
  const title = str(req.body.title, 100); if (!title) bad('Enter an offer title');
  const b = await Banner.findByIdAndUpdate(needId(req.params.id), { title }, { new: true });
  if (!b) bad('Banner not found', 404); res.json(b);
}));
app.delete('/api/admin/banners/:id', admin, wrap(async (req, res) => {
  await Banner.deleteOne({ _id: needId(req.params.id) }); res.json({ ok: true });
}));

/* offers */
app.post('/api/admin/offers', admin, wrap(async (req, res) => {
  const title = str(req.body.title, 100); if (!title) bad('Enter an offer title');
  res.status(201).json(await Offer.create({ title, text: str(req.body.text, 200) }));
}));
app.delete('/api/admin/offers/:id', admin, wrap(async (req, res) => {
  await Offer.deleteOne({ _id: needId(req.params.id) }); res.json({ ok: true });
}));

/* payment QR + shop settings */
app.put('/api/admin/qr/:method', admin, wrap(async (req, res) => {
  const m = req.params.method;
  if (!['PhonePe', 'GPay', 'Paytm'].includes(m)) bad('Invalid method');
  const v = img(req.body.img); if (!v || v.length <= 16) bad('Choose a valid QR image');
  await QR.findOneAndUpdate({ method: m }, { img: v }, { upsert: true }); res.json({ ok: true });
}));
app.delete('/api/admin/qr/:method', admin, wrap(async (req, res) => {
  await QR.deleteOne({ method: str(req.params.method, 20) }); res.json({ ok: true });
}));
app.put('/api/admin/shop', admin, wrap(async (req, res) => {
  const b = req.body, set = {};
  for (const k of ['name', 'phone', 'wa', 'email', 'addr']) if (b[k] !== undefined) set[k] = str(b[k], 200);
  if (set.name === '') bad('Shop name cannot be empty');
  if (b.logo !== undefined) set.logo = img(b.logo, '🐟');
  for (const k of ['ig', 'fb', 'yt']) if (b[k] !== undefined) set[k] = link(b[k]);
  res.json(await Shop.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true }));
}));

/* ---------- errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Image is too large. Use a smaller image.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* ---------- first-run sample data ---------- */
async function seed() {
  if (await Category.countDocuments() || await Product.countDocuments()) return;
  await Shop.create({ name: 'Aqua World', logo: '🐟', phone: '+91 90000 00000', wa: '919000000000', email: 'hello@aquaworld.example', addr: 'Main Road, Ooty, Tamil Nadu 643001', ig: '', fb: '', yt: '' });
  const cats = await Category.insertMany([['Gold Fish', '🐠'], ['Betta Fish', '🐟'], ['Guppy Fish', '🐡'], ['Flowerhorn Fish', '🦈'], ['Tetra Fish', '🐠'], ['Aquarium Accessories', '🪸']].map(c => ({ name: c[0], img: c[1] })));
  const P = [['Gold Fish', 0, 199, 149, '🐠'], ['Fancy Gold Fish', 0, 299, 239, '🐠'], ['Betta Halfmoon', 1, 249, 189, '🐟'], ['Betta Plakat', 1, 199, 149, '🐟'], ['Guppy Mix', 2, 99, 69, '🐡'], ['Flowerhorn Baby', 3, 899, 699, '🦈'], ['Neon Tetra', 4, 60, 45, '🐠'], ['Air Pump', 5, 399, 299, '🫧']];
  await Product.insertMany(P.map((p, i) => ({ name: p[0], cat: String(cats[p[1]]._id), mrp: p[2], price: p[3], pmrp: p[2] * 2, pprice: Math.round(p[3] * 1.9), single: true, pair: p[1] < 5, stock: i === 6 ? 0 : 20, avail: true, desc: 'Healthy, well-fed and carefully packed.', img: p[4] })).reverse());
  await Banner.insertMany([{ title: 'Monsoon Fish Fest', text: 'Up to 25% off on Gold Fish & Betta', img: '', order: 0 }, { title: 'Flowerhorn Special', text: 'Premium babies from ₹699', img: '', order: 1 }]);
  await Offer.create({ title: 'Free delivery', text: 'Orders above ₹999' });
  console.log('Sample shop data created.');
}

mongoose.connect(MONGODB_URI).then(async () => {
  await Promise.all([Product, Order, Customer, QR].map(m => m.init()));
  await seed();
  app.listen(PORT, () => console.log(`Aqua World running at http://localhost:${PORT}`));
}).catch(e => { console.error('Could not start. Is MongoDB running?\n', e.message); process.exit(1); });
