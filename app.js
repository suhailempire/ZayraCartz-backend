// ===================================================
// ZAYRACARTZ FLIPKART-GRADE JAVASCRIPT ENGINE (app.js)
// ===================================================

let products = [];
let cart = JSON.parse(localStorage.getItem('zc_cart') || '[]');
let wishlist = JSON.parse(localStorage.getItem('zc_wishlist') || '[]');
let activeProduct = null;
let selectedVariant = null;
let storeUpiId = "zayracarts@gmail.com";
let activeCategory = 'all';

// ---------------------------------------------------
// 1. INITIALIZATION & DATA LOADING
// ---------------------------------------------------
async function initStore() {
  try {
    // 1. Store settings
    const sRes = await fetch('/api/settings/public');
    const s = await sRes.json();
    if (s.store_upi_id) storeUpiId = s.store_upi_id;

    // 2. Products inventory
    const pRes = await fetch('/api/products');
    products = await pRes.json();

    renderHomeProducts();
    updateCartBadge();
    startFlipkartCountdown();
  } catch (err) {
    console.error("Store init failure:", err);
  }
}

// Flipkart Flash Deal Countdown Timer (Live Ticking)
function startFlipkartCountdown() {
  const timerEl = document.getElementById('clockTimer');
  if (!timerEl) return;
  let secondsLeft = 15480; // ~4.3 hours
  setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) secondsLeft = 18000;
    const h = String(Math.floor(secondsLeft / 3600)).padStart(2, '0');
    const m = String(Math.floor((secondsLeft % 3600) / 60)).padStart(2, '0');
    const s = String(secondsLeft % 60).padStart(2, '0');
    timerEl.innerText = `${h}h : ${m}m : ${s}s`;
  }, 1000);
}

// ---------------------------------------------------
// 2. CATALOG & FILTERING ENGINE
// ---------------------------------------------------
function renderHomeProducts() {
  const grid = document.getElementById('productGrid');
  let filtered = products;

  if (activeCategory !== 'all') {
    filtered = products.filter(p => {
      const t = p.title.toLowerCase();
      if (activeCategory === 'fashion') return t.includes('tee') || t.includes('shirt') || t.includes('hoodie') || t.includes('cargo') || t.includes('apparel');
      if (activeCategory === 'shoes') return t.includes('shoe') || t.includes('sneaker') || t.includes('slide') || t.includes('kicks');
      if (activeCategory === 'watches') return t.includes('watch') || t.includes('bracelet') || t.includes('chain');
      if (activeCategory === 'gadgets') return t.includes('pod') || t.includes('ear') || t.includes('smart') || t.includes('tech');
      if (activeCategory === 'fragrance') return t.includes('perfume') || t.includes('scent') || t.includes('cologne');
      if (activeCategory === 'bags') return t.includes('bag') || t.includes('wallet') || t.includes('pack');
      return true;
    });
  }

  const query = (document.getElementById('mainSearch').value || '').toLowerCase().trim();
  if (query) {
    filtered = filtered.filter(p => p.title.toLowerCase().includes(query) || (p.description && p.description.toLowerCase().includes(query)));
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<p style="text-align:center; grid-column:1/-1; padding:35px 10px; color:#666;">No products found in this category.</p>';
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const isWished = wishlist.includes(p.id);
    const img = (p.images && p.images[0]) || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=600';
    const mrp = p.compare_at_price || Math.round(p.price * 1.45);
    const off = Math.round(((mrp - p.price) / mrp) * 100);

    return `
      <div class="card" onclick="openPdp(${p.id})">
        <div class="card-img-box">
          <img src="${img}" alt="${p.title}" class="card-img" loading="lazy">
          <button class="wish-btn ${isWished ? 'active' : ''}" onclick="event.stopPropagation(); toggleWishlist(${p.id})">
            <svg width="16" height="16" fill="none" stroke="#1C1C1C" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </button>
        </div>
        <div class="card-content">
          <span class="card-brand">Zayra Verified</span>
          <h4 class="card-title">${p.title}</h4>
          <div class="rating-badge">4.3 ★</div>
          <div class="price-row">
            <span class="card-price">₹${p.price}</span>
            <span class="card-mrp">₹${mrp}</span>
            <span class="card-off">${off}% off</span>
          </div>
          <div class="card-tag">Free Delivery by Tomorrow</div>
        </div>
      </div>
    `;
  }).join('');
}

function handleSearch() {
  openView('home');
  renderHomeProducts();
}

function filterCat(cat) {
  activeCategory = cat;
  openView('home');
  renderHomeProducts();
}

// ---------------------------------------------------
// 3. FLIPKART DEDICATED PRODUCT DETAILS & LIVE VARIANTS
// ---------------------------------------------------
function openPdp(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  activeProduct = p;

  document.getElementById('pdpCatName').innerText = p.title;
  document.getElementById('pdpTitle').innerText = p.title;
  document.getElementById('pdpMainImg').src = (p.images && p.images[0]) || 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=600';

  // Smart Variant Generation (Shoes, Perfumes, Clothes, Tech)
  const t = p.title.toLowerCase();
  let variants = [];
  let vLabel = "Select Option:";

  if (t.includes('perfume') || t.includes('scent') || t.includes('cologne') || t.includes('attar')) {
    vLabel = "Select Volume / Bottle:";
    variants = [
      { name: "50 ml", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "100 ml", priceMultiplier: 1.7, mrpMultiplier: 2.3 }
    ];
  } else if (t.includes('shoe') || t.includes('sneaker') || t.includes('slide') || t.includes('kicks')) {
    vLabel = "Select Shoe Size (UK/India):";
    variants = [
      { name: "UK 7", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "UK 8", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "UK 9", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "UK 10", priceMultiplier: 1.05, mrpMultiplier: 1.5 }
    ];
  } else if (t.includes('combo') || t.includes('pack')) {
    vLabel = "Select Quantity Pack:";
    variants = [
      { name: "Single Pack", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "Pack of 2 (Save Extra)", priceMultiplier: 1.8, mrpMultiplier: 2.6 }
    ];
  } else {
    vLabel = "Select Size:";
    variants = [
      { name: "S", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "M", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "L", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "XL", priceMultiplier: 1.0, mrpMultiplier: 1.4 },
      { name: "XXL", priceMultiplier: 1.1, mrpMultiplier: 1.5 }
    ];
  }

  document.getElementById('variantLabel').innerText = vLabel;
  const vBox = document.getElementById('variantOptions');
  vBox.innerHTML = variants.map((v, idx) => {
    const vPrice = Math.round(p.price * v.priceMultiplier);
    return `
      <button class="variant-pill ${idx === 0 ? 'selected' : ''}" onclick="switchVariant('${v.name}', ${v.priceMultiplier}, ${v.mrpMultiplier}, this)">
        ${v.name}
      </button>
    `;
  }).join('');

  // Default first variant active
  switchVariant(variants[0].name, variants[0].priceMultiplier, variants[0].mrpMultiplier, null);

  // Reset pincode check
  document.getElementById('pinInput').value = '';
  document.getElementById('pinStatus').innerText = '';

  openView('pdp');
}

// LIVE DYNAMIC PRICE SWITCHING (When user taps 50ml vs 100ml)
function switchVariant(name, pMult, mMult, btnEl) {
  if (!activeProduct) return;
  selectedVariant = {
    name: name,
    price: Math.round(activeProduct.price * pMult),
    mrp: Math.round(activeProduct.price * mMult)
  };

  if (btnEl) {
    document.querySelectorAll('.variant-pill').forEach(b => b.classList.remove('selected'));
    btnEl.classList.add('selected');
  }

  // Update Live Price, MRP & Discount with Animation
  const priceEl = document.getElementById('pdpPrice');
  priceEl.innerText = `₹${selectedVariant.price}`;
  document.getElementById('pdpMrp').innerText = `₹${selectedVariant.mrp}`;

  const off = Math.round(((selectedVariant.mrp - selectedVariant.price) / selectedVariant.mrp) * 100);
  document.getElementById('pdpOff').innerText = `${off}% off`;
}

// Flipkart Delivery Pincode Checker
function checkPincode() {
  const pin = document.getElementById('pinInput').value.trim();
  const status = document.getElementById('pinStatus');
  if (!/^\d{6}$/.test(pin)) {
    status.style.color = "#e74c3c";
    status.innerText = "Please enter valid 6-digit Pincode.";
    return;
  }
  status.style.color = "#26a541";
  status.innerText = `✓ Express Delivery available to ${pin} by Tomorrow | Free Shipping`;
}

// ---------------------------------------------------
// 4. CART & BUY NOW LOGIC
// ---------------------------------------------------
function addPdpToCart() {
  if (!activeProduct || !selectedVariant) return;

  const existing = cart.find(x => x.product_id === activeProduct.id && x.variant === selectedVariant.name);
  if (existing) {
    existing.quantity++;
  } else {
    cart.push({
      product_id: activeProduct.id,
      title: activeProduct.title,
      price: selectedVariant.price,
      variant: selectedVariant.name,
      quantity: 1,
      image: (activeProduct.images && activeProduct.images[0]) || ''
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
  const d = document.getElementById('cartDrawer');
  const o = document.getElementById('overlay');
  if (open) {
    renderCartList();
    d.classList.add('open');
    o.style.display = 'block';
  } else {
    d.classList.remove('open');
    o.style.display = 'none';
  }
}

function renderCartList() {
  const box = document.getElementById('cartList');
  let total = 0;

  if (cart.length === 0) {
    box.innerHTML = '<p style="text-align:center; padding:40px 10px; color:#878787;">Your cart is empty.</p>';
    document.getElementById('cartSum').innerText = '₹0';
    return;
  }

  box.innerHTML = cart.map((item, idx) => {
    total += item.price * item.quantity;
    return `
      <div style="display:flex; gap:10px; margin-bottom:12px; border-bottom:1px solid #EEE; padding-bottom:10px;">
        <img src="${item.image}" style="width:55px; height:65px; object-fit:cover; border-radius:3px;">
        <div style="flex-grow:1;">
          <b style="font-size:13px;">${item.title}</b>
          <div style="font-size:11px; color:#878787;">Option: ${item.variant}</div>
          <div style="font-weight:700; font-size:14px; margin-top:2px;">₹${item.price}</div>
          <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
            <button onclick="changeQty(${idx}, -1)" style="padding:2px 8px; border:1px solid #CCC; background:#FFF; cursor:pointer;">-</button>
            <span style="font-size:13px; font-weight:700;">${item.quantity}</span>
            <button onclick="changeQty(${idx}, 1)" style="padding:2px 8px; border:1px solid #CCC; background:#FFF; cursor:pointer;">+</button>
            <button onclick="cart.splice(${idx},1); localStorage.setItem('zc_cart', JSON.stringify(cart)); renderCartList(); updateCartBadge();" style="border:none; background:none; color:red; font-size:12px; margin-left:auto; cursor:pointer;">Remove</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('cartSum').innerText = `₹${total}`;
}

function changeQty(idx, delta) {
  cart[idx].quantity += delta;
  if (cart[idx].quantity <= 0) cart.splice(idx, 1);
  localStorage.setItem('zc_cart', JSON.stringify(cart));
  renderCartList();
  updateCartBadge();
}

function updateCartBadge() {
  const count = cart.reduce((a,c) => a + c.quantity, 0);
  document.getElementById('cBadge').innerText = count;
}

// ---------------------------------------------------
// 5. CHECKOUT & DYNAMIC UPI QR FLOW
// ---------------------------------------------------
function startCheckout() {
  if (cart.length === 0) return alert("Your cart is empty!");
  toggleCart(false);

  const modal = document.getElementById('checkoutModal');
  const overlay = document.getElementById('overlay');
  modal.style.display = 'block';
  overlay.style.display = 'block';

  // Toggle UPI area on select
  const select = document.getElementById('cPayMethod');
  select.onchange = function() {
    togglePaymentArea();
  };
  togglePaymentArea();
}

function togglePaymentArea() {
  const method = document.getElementById('cPayMethod').value;
  const upiBox = document.getElementById('upiArea');
  if (method === 'DIRECT_UPI') {
    const total = cart.reduce((a,c) => a + (c.price * c.quantity), 0);
    const tempId = 'ZC' + Math.floor(Math.random() * 89999 + 10000);
    const upiStr = `upi://pay?pa=${encodeURIComponent(storeUpiId)}&pn=ZayraCartz&am=${total}&cu=INR&tn=${tempId}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(upiStr)}`;

    document.getElementById('qrImage').src = qrUrl;
    document.getElementById('intentLink').href = upiStr;
    upiBox.style.display = 'block';
  } else {
    upiBox.style.display = 'none';
  }
}

async function placeOrder() {
  const name = document.getElementById('cName').value.trim();
  const phone = document.getElementById('cPhone').value.trim();
  const address = document.getElementById('cAddress').value.trim();
  const method = document.getElementById('cPayMethod').value;
  const utr = document.getElementById('utrCode').value.trim();

  if (!name || !phone || !address) {
    return alert("Please enter Full Name, Phone, and Address!");
  }

  if (method === 'DIRECT_UPI') {
    if (!/^\d{12}$/.test(utr)) {
      return alert("⚠️ Please enter exact 12-digit UPI Reference Number / UTR from your bank payment receipt.");
    }
  }

  const payload = {
    customer_name: name,
    customer_email: 'customer@zayracartz.com',
    customer_phone: phone,
    shipping_street: address,
    shipping_city: 'India',
    shipping_state: 'India',
    shipping_pincode: '000000',
    payment_method: method,
    utr_number: method === 'DIRECT_UPI' ? utr : null,
    items: cart
  };

  try {
    const res = await fetch('/api/checkout/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (res.ok) {
      closeAll();
      alert(`🎉 Order Placed Successfully!\n\nOrder No: ${data.order.order_number}\nStatus: ${data.order.payment_status}\n\nThank you for choosing ZayraCartz!`);
      cart = [];
      localStorage.removeItem('zc_cart');
      updateCartBadge();
      openView('home');
    } else {
      alert("⚠️ " + (data.error || "Order placement failed."));
    }
  } catch (err) {
    alert("Server error. Please try again.");
  }
}

// ---------------------------------------------------
// 6. LIVE ORDER TRACKING
// ---------------------------------------------------
async function runTracking() {
  const code = document.getElementById('trackCode').value.trim().toUpperCase();
  const resultBox = document.getElementById('trackResult');
  if (!code) return alert("Enter your order number (e.g. ZC-123456)");

  resultBox.innerHTML = '<p style="color:#666;">Checking database...</p>';
  try {
    const res = await fetch(`/api/orders/track/${encodeURIComponent(code)}`);
    const data = await res.json();

    if (res.ok) {
      resultBox.innerHTML = `
        <div style="background:#FFF; border:1px solid #2874f0; padding:16px; border-radius:4px; margin-top:14px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
            <b style="font-size:16px;">Order #${data.order_number}</b>
            <span style="color:#26a541; font-weight:700;">₹${data.total_amount}</span>
          </div>
          <p style="margin:4px 0;">Customer: <b>${data.customer_name}</b></p>
          <p style="margin:4px 0;">Status: <b style="color:#2874f0;">${data.order_status}</b> (${data.payment_status})</p>
          <p style="margin:4px 0;">Courier: <b>${data.tracking_courier || 'Packing in progress'}</b></p>
          <p style="margin:4px 0;">Tracking AWB: <b>${data.tracking_number || 'Will update on dispatch'}</b></p>
        </div>
      `;
    } else {
      resultBox.innerHTML = `<p style="color:red; margin-top:10px;">Order #${code} not found. Please check your order code.</p>`;
    }
  } catch (err) {
    resultBox.innerHTML = '<p style="color:red; margin-top:10px;">Tracking service currently unavailable.</p>';
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

  let reply = "I am here to help! You can browse deals, track orders, or connect with our human team directly on WhatsApp.";
  const q = text.toLowerCase();

  if (q.includes('track') || q.includes('order') || q.includes('status')) {
    reply = "To track your order, click the truck/box icon in the top header or go to Track Order, and enter your order code (e.g. ZC-123456).";
  } else if (q.includes('pay') || q.includes('upi') || q.includes('qr') || q.includes('cod')) {
    reply = "We support Dynamic UPI QR payments (GPay, PhonePe, Paytm) and Cash on Delivery (COD). When paying via UPI, enter your 12-digit UTR from your bank app receipt.";
  } else if (q.includes('return') || q.includes('refund') || q.includes('exchange')) {
    reply = "We offer a 5-day replacement policy for damaged, defective, or incorrect size items. Email zayracarts@gmail.com with your unboxing video/photo.";
  } else if (q.includes('whatsapp') || q.includes('human') || q.includes('help')) {
    reply = `Click here to chat with our owner directly on WhatsApp: <a href="https://wa.me/919876543210?text=Hello%20ZayraCartz" target="_blank" style="color:#2874f0; font-weight:700;">Open WhatsApp</a>`;
  }

  setTimeout(() => {
    chat.innerHTML += `<div style="background:#FFF; padding:8px 10px; border-radius:4px; border:1px solid #DDD; align-self:flex-start;">${reply}</div>`;
    chat.scrollTop = chat.scrollHeight;
  }, 400);
}

// ---------------------------------------------------
// 8. ROUTING & UI HELPERS
// ---------------------------------------------------
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

function toggleWishlist(id) {
  if (wishlist.includes(id)) wishlist = wishlist.filter(x => x !== id);
  else wishlist.push(id);
  localStorage.setItem('zc_wishlist', JSON.stringify(wishlist));
  renderHomeProducts();
}

// Start Engine
initStore();
