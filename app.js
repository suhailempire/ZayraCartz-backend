/**
 * ZayraCartz Storefront Engine (app.js)
 * Fully aligned with Stage 1 Backend (Integer Paise API & Atomic Stock Locks)
 */

let products = [];
let cart = JSON.parse(localStorage.getItem('zc_cart') || '[]');
let wishlist = JSON.parse(localStorage.getItem('zc_wishlist') || '[]');
let activeProduct = null;
let selectedVariant = null;
let activeCategory = 'all';
const storeUpiId = "zayracarts@gmail.com";

// ---------------------------------------------------
// 1. INITIALIZATION & LIVE CATALOG INGESTION
// ---------------------------------------------------
async function initStore() {
  try {
    const res = await fetch('/api/products');
    const data = await res.json();
    products = data.products || [];

    renderCatalog();
    updateCartBadge();
    startFlashDealCountdown();
  } catch (err) {
    console.error('Catalog ingestion failure:', err);
  }
}

function startFlashDealCountdown() {
  const timer = document.getElementById('clockTimer');
  if (!timer) return;
  let remaining = 15640;
  setInterval(() => {
    remaining--;
    if (remaining <= 0) remaining = 18000;
    const h = String(Math.floor(remaining / 3600)).padStart(2, '0');
    const m = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    timer.innerText = `${h}h : ${m}m : ${s}s`;
  }, 1000);
}

// ---------------------------------------------------
// 2. DISCOVERY & FILTERING
// ---------------------------------------------------
function renderCatalog() {
  const grid = document.getElementById('productGrid');
  let filtered = products;

  if (activeCategory !== 'all') {
    filtered = products.filter(p => {
      const t = (p.title + ' ' + (p.category_name || '')).toLowerCase();
      if (activeCategory === 'fashion') return t.includes('tee') || t.includes('shirt') || t.includes('hoodie') || t.includes('clothing');
      if (activeCategory === 'shoes') return t.includes('shoe') || t.includes('sneaker') || t.includes('footwear');
      if (activeCategory === 'watches') return t.includes('watch') || t.includes('bracelet');
      if (activeCategory === 'gadgets') return t.includes('gadget') || t.includes('pod') || t.includes('tech');
      if (activeCategory === 'fragrance') return t.includes('perfume') || t.includes('scent') || t.includes('attar');
      if (activeCategory === 'bags') return t.includes('bag') || t.includes('wallet');
      return true;
    });
  }

  const query = (document.getElementById('mainSearch').value || '').toLowerCase().trim();
  if (query) {
    filtered = filtered.filter(p => p.title.toLowerCase().includes(query) || (p.description && p.description.toLowerCase().includes(query)));
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<p style="text-align:center; grid-column:1/-1; padding:40px 10px; color:#777;">No products found in this category.</p>';
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const isWished = wishlist.includes(p.id);
    const firstVariant = (p.variants && p.variants[0]) || {};
    const img = (firstVariant.images && firstVariant.images[0]) || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=600';
    const priceInr = (Number(p.base_price_paise) / 100).toFixed(0);
    const mrpInr = p.compare_at_price_paise ? (Number(p.compare_at_price_paise) / 100).toFixed(0) : (Number(p.base_price_paise) * 1.4 / 100).toFixed(0);
    const discountPercent = Math.round(((mrpInr - priceInr) / mrpInr) * 100);

    return `
      <div class="card" onclick="openPdp(${p.id})">
        <div class="card-img-box">
          <img src="${img}" alt="${p.title}" class="card-img" loading="lazy">
          <button class="wish-btn ${isWished ? 'active' : ''}" onclick="event.stopPropagation(); toggleWish(${p.id})">
            <svg width="15" height="15" fill="none" stroke="#1C1C1C" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </button>
        </div>
        <div class="card-content">
          <span class="card-brand">${p.brand || 'Zayra Verified'}</span>
          <h4 class="card-title">${p.title}</h4>
          <div class="rating-badge">4.3 ★</div>
          <div class="price-row">
            <span class="card-price">₹${priceInr}</span>
            <span class="card-mrp">₹${mrpInr}</span>
            <span class="card-off">${discountPercent}% off</span>
          </div>
          <div class="card-tag">Free Delivery by Tomorrow</div>
        </div>
      </div>
    `;
  }).join('');
}

function handleSearch() {
  openView('home');
  renderCatalog();
}

function filterCat(cat) {
  activeCategory = cat;
  openView('home');
  renderCatalog();
}

// ---------------------------------------------------
// 3. FLIPKART-GRADE DYNAMIC PDP & VARIANT PRICING
// ---------------------------------------------------
function openPdp(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  activeProduct = p;

  document.getElementById('pdpCatName').innerText = p.title;
  document.getElementById('pdpTitle').innerText = p.title;

  const variants = (p.variants && p.variants.length > 0) ? p.variants : [{
    id: 0,
    sku: 'DEFAULT',
    title: 'Standard',
    price_paise: p.base_price_paise,
    compare_at_price_paise: p.compare_at_price_paise || (BigInt(p.base_price_paise) * 14n / 10n).toString(),
    images: []
  }];

  const firstVar = variants[0];
  document.getElementById('pdpMainImg').src = (firstVar.images && firstVar.images[0]) || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=600';

  // Render Variant Selection Buttons with Live Price Switching
  const variantBox = document.getElementById('variantOptions');
  variantBox.innerHTML = variants.map((v, idx) => `
    <button class="variant-pill ${idx === 0 ? 'selected' : ''}" onclick="selectVariant(${v.id}, this)">
      ${v.title}
    </button>
  `).join('');

  selectVariant(variants[0].id, variantBox.firstElementChild);
  document.getElementById('pinInput').value = '';
  document.getElementById('pinStatus').innerText = '';

  openView('pdp');
}

function selectVariant(variantId, btnElement) {
  if (!activeProduct) return;
  const v = activeProduct.variants.find(x => x.id === variantId) || activeProduct.variants[0];
  selectedVariant = v;

  if (btnElement) {
    document.querySelectorAll('.variant-pill').forEach(b => b.classList.remove('selected'));
    btnElement.classList.add('selected');
  }

  // Calculate live INR values from integer paise
  const priceInr = (Number(v.price_paise) / 100).toFixed(0);
  const mrpInr = v.compare_at_price_paise ? (Number(v.compare_at_price_paise) / 100).toFixed(0) : (Number(v.price_paise) * 1.4 / 100).toFixed(0);
  const discountPercent = Math.round(((mrpInr - priceInr) / mrpInr) * 100);

  document.getElementById('pdpPrice').innerText = `₹${priceInr}`;
  document.getElementById('pdpMrp').innerText = `₹${mrpInr}`;
  document.getElementById('pdpOff').innerText = `${discountPercent}% off`;

  if (v.images && v.images.length > 0) {
    document.getElementById('pdpMainImg').src = v.images[0];
  }
}

function checkPincode() {
  const pin = document.getElementById('pinInput').value.trim();
  const status = document.getElementById('pinStatus');
  if (!/^[1-9][0-9]{5}$/.test(pin)) {
    status.style.color = "#e74c3c";
    status.innerText = "Please enter a valid 6-digit Indian Pincode.";
    return;
  }
  status.style.color = "#26a541";
  status.innerText = `✓ Express Delivery available to ${pin} by Tomorrow | Free Shipping`;
}

// ---------------------------------------------------
// 4. CART & PERSISTENT CHECKOUT
// ---------------------------------------------------
function addPdpToCart() {
  if (!activeProduct || !selectedVariant) return;

  const existing = cart.find(x => x.variant_id === selectedVariant.id);
  if (existing) {
    existing.quantity++;
  } else {
    cart.push({
      product_id: activeProduct.id,
      variant_id: selectedVariant.id,
      title: activeProduct.title,
      variant_title: selectedVariant.title,
      price_paise: selectedVariant.price_paise,
      price_inr: (Number(selectedVariant.price_paise) / 100).toFixed(0),
      quantity: 1,
      image: (selectedVariant.images && selectedVariant.images[0]) || ''
    });
  }

  localStorage.setItem('zc_cart', JSON.stringify(cart));
  updateCartBadge();
  toggleCart(true);
}

function buyNowPdp() {
  addPdpToCart();
  toggleCart(false);
  startCheckout();
}

function toggleCart(open) {
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('overlay');
  if (open) {
    renderCart();
    drawer.classList.add('open');
    overlay.style.display = 'block';
  } else {
    drawer.classList.remove('open');
    overlay.style.display = 'none';
  }
}

function renderCart() {
  const container = document.getElementById('cartList');
  let totalInr = 0;

  if (cart.length === 0) {
    container.innerHTML = '<p style="text-align:center; padding:40px 10px; color:#888;">Your bag is empty.</p>';
    document.getElementById('cartSum').innerText = '₹0';
    return;
  }

  container.innerHTML = cart.map((item, idx) => {
    totalInr += Number(item.price_inr) * item.quantity;
    return `
      <div style="display:flex; gap:10px; margin-bottom:12px; border-bottom:1px solid #EEE; padding-bottom:10px;">
        <img src="${item.image || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=600'}" style="width:55px; height:65px; object-fit:cover; border-radius:3px;">
        <div style="flex-grow:1;">
          <b style="font-size:13px;">${item.title}</b>
          <div style="font-size:11px; color:#878787;">${item.variant_title}</div>
          <div style="font-weight:700; font-size:14px; margin-top:2px;">₹${item.price_inr}</div>
          <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
            <button onclick="changeQty(${idx}, -1)" style="padding:2px 8px; border:1px solid #CCC; background:#FFF; cursor:pointer;">-</button>
            <span style="font-size:13px; font-weight:700;">${item.quantity}</span>
            <button onclick="changeQty(${idx}, 1)" style="padding:2px 8px; border:1px solid #CCC; background:#FFF; cursor:pointer;">+</button>
            <button onclick="cart.splice(${idx},1); localStorage.setItem('zc_cart', JSON.stringify(cart)); renderCart(); updateCartBadge();" style="border:none; background:none; color:red; font-size:12px; margin-left:auto; cursor:pointer;">Remove</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('cartSum').innerText = `₹${totalInr}`;
}

function changeQty(index, delta) {
  cart[index].quantity += delta;
  if (cart[index].quantity <= 0) cart.splice(index, 1);
  localStorage.setItem('zc_cart', JSON.stringify(cart));
  renderCart();
  updateCartBadge();
}

function updateCartBadge() {
  const total = cart.reduce((acc, c) => acc + c.quantity, 0);
  document.getElementById('cBadge').innerText = total;
}

function toggleWish(id) {
  if (wishlist.includes(id)) wishlist = wishlist.filter(x => x !== id);
  else wishlist.push(id);
  localStorage.setItem('zc_wishlist', JSON.stringify(wishlist));
  renderCatalog();
}

// ---------------------------------------------------
// 5. SERVER-SIDE CHECKOUT & DYNAMIC UPI QR
// ---------------------------------------------------
function startCheckout() {
  if (cart.length === 0) return alert('Your cart is empty!');
  toggleCart(false);

  document.getElementById('checkoutModal').style.display = 'block';
  document.getElementById('overlay').style.display = 'block';

  const select = document.getElementById('cPayMethod');
  select.onchange = toggleUpiView;
  toggleUpiView();
}

function toggleUpiView() {
  const method = document.getElementById('cPayMethod').value;
  const upiArea = document.getElementById('upiArea');
  if (method === 'DIRECT_UPI_QR') {
    const subtotal = cart.reduce((acc, c) => acc + (Number(c.price_inr) * c.quantity), 0);
    const shipping = subtotal >= 999 ? 0 : 79;
    const finalBill = subtotal + shipping;

    const tempOrderRef = `ZC${Date.now().toString().slice(-6)}`;
    const upiUri = `upi://pay?pa=${encodeURIComponent(storeUpiId)}&pn=ZayraCartz&am=${finalBill}&cu=INR&tn=${tempOrderRef}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(upiUri)}`;

    document.getElementById('qrImage').src = qrUrl;
    document.getElementById('intentLink').href = upiUri;
    upiArea.style.display = 'block';
  } else {
    upiArea.style.display = 'none';
  }
}

async function placeOrder() {
  const name = document.getElementById('cName').value.trim();
  const email = document.getElementById('cEmail').value.trim();
  const phone = document.getElementById('cPhone').value.trim();
  const street = document.getElementById('cAddress').value.trim();
  const city = document.getElementById('cCity').value.trim();
  const state = document.getElementById('cState').value.trim();
  const pincode = document.getElementById('cPin').value.trim();
  const method = document.getElementById('cPayMethod').value;

  if (!name || !email || !phone || !street || !city || !pincode) {
    return alert('Please fill in all mandatory delivery address fields.');
  }

  if (!/^[1-9][0-9]{5}$/.test(pincode)) {
    return alert('Please enter a valid 6-digit Indian Pincode.');
  }

  // Format payload for Stage 1 Backend (Atomic Stock Check)
  const orderPayload = {
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    shipping_street: street,
    shipping_city: city,
    shipping_state: state || 'India',
    shipping_pincode: pincode,
    payment_method: method,
    items: cart.map(i => ({ variant_id: i.variant_id, quantity: i.quantity }))
  };

  try {
    const res = await fetch('/api/checkout/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload)
    });

    const data = await res.json();

    if (res.ok) {
      closeAll();
      alert(`🎉 Order Confirmed!\n\nOrder Number: ${data.order.order_number}\nPayable: ₹${data.order.formatted_total_inr}\nStatus: ${data.order.order_status}\n\nInventory has been reserved for your package.`);
      cart = [];
      localStorage.removeItem('zc_cart');
      updateCartBadge();
      openView('home');
    } else {
      alert(`⚠️ Checkout Error: ${data.error}`);
    }
  } catch (err) {
    alert('Network connectivity issue. Please try again.');
  }
}

// ---------------------------------------------------
// 6. REAL-TIME LOGISTICS TRACKING
// ---------------------------------------------------
async function runTracking() {
  const code = document.getElementById('trackCode').value.trim().toUpperCase();
  const resBox = document.getElementById('trackResult');
  if (!code) return alert('Please enter an order number.');

  resBox.innerHTML = '<p style="color:#666;">Checking logistics registry...</p>';

  try {
    const res = await fetch(`/api/orders/track/${encodeURIComponent(code)}`);
    const data = await res.json();

    if (res.ok) {
      resBox.innerHTML = `
        <div style="background:#FFF; border:1px solid #2874f0; padding:16px; border-radius:4px; margin-top:14px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
            <b style="font-size:16px;">Order #${data.order_number}</b>
            <span style="color:#26a541; font-weight:700;">₹${data.total_inr}</span>
          </div>
          <p style="margin:4px 0;">Customer: <b>${data.customer_name}</b></p>
          <p style="margin:4px 0;">Lifecycle Status: <b style="color:#2874f0;">${data.order_status}</b> (${data.payment_status})</p>
          <p style="margin:4px 0;">Logistics Hub: <b>${data.courier_partner}</b></p>
          <p style="margin:4px 0;">Shipment Tracking: <b>${data.tracking_number || 'Package is undergoing warehouse sorting'}</b></p>
        </div>
      `;
    } else {
      resBox.innerHTML = `<p style="color:red; margin-top:10px;">${data.error}</p>`;
    }
  } catch (err) {
    resBox.innerHTML = '<p style="color:red; margin-top:10px;">Tracking service offline.</p>';
  }
}

// ---------------------------------------------------
// 7. AI ASSISTANT CHATBOT ("ZAYRA BOT")
// ---------------------------------------------------
function toggleBot() {
  const b = document.getElementById('botChat');
  b.style.display = (b.style.display === 'flex') ? 'none' : 'flex';
}

function sendBot() {
  const inp = document.getElementById('botText');
  const text = inp.value.trim();
  if (!text) return;

  const chat = document.getElementById('botMsgs');
  chat.innerHTML += `<div style="background:var(--charcoal); color:#FFF; padding:8px 10px; border-radius:4px; align-self:flex-end;">${text}</div>`;
  inp.value = '';

  let reply = "I am here to assist your shopping experience! You can track shipments or ask about our return policies.";
  const q = text.toLowerCase();

  if (q.includes('track') || q.includes('order')) {
    reply = "To track an order, tap the delivery box icon in the header or enter your order number in the Track Order view.";
  } else if (q.includes('pay') || q.includes('upi') || q.includes('cod')) {
    reply = "We support Dynamic UPI QR payments (GPay, PhonePe, Paytm) with zero gateway markups, as well as Cash on Delivery.";
  } else if (q.includes('return') || q.includes('exchange')) {
    reply = "We operate a 5-day replacement policy for defective or damaged items upon unboxing. Reach out to zayracarts@gmail.com.";
  }

  setTimeout(() => {
    chat.innerHTML += `<div style="background:#FFF; padding:8px 10px; border-radius:4px; border:1px solid #DDD; align-self:flex-start;">${reply}</div>`;
    chat.scrollTop = chat.scrollHeight;
  }, 400);
}

// Navigation Helper
function openView(viewName) {
  document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(`view-${viewName}`);
  if (el) el.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeAll() {
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('cartDrawer').classList.remove('open');
  document.getElementById('checkoutModal').style.display = 'none';
}

initStore();
