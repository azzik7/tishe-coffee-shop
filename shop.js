(() => {
  "use strict";

  const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 });
  const state = { products: [], cart: loadCart(), user: null };
  const $ = (selector) => document.querySelector(selector);
  const productGrid = $("#productGrid");
  const cartDrawer = $("#cartDrawer");
  const cartItems = $("#cartItems");
  const checkoutSummary = $("#checkoutSummary");
  const checkoutForm = $("#checkoutForm");
  const checkoutStatus = $("#checkoutStatus");
  const accountDialog = $("#accountDialog");

  function loadCart() {
    try {
      const parsed = JSON.parse(localStorage.getItem("tishe_cart") || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => item.productId && item.variantId && Number(item.quantity) > 0) : [];
    } catch { return []; }
  }

  function saveCart() {
    localStorage.setItem("tishe_cart", JSON.stringify(state.cart));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Что-то пошло не так.");
    return data;
  }

  function findVariant(productId, variantId) {
    const product = state.products.find((item) => item.id === productId);
    return { product, variant: product?.variants.find((item) => item.id === variantId) };
  }

  function detailedCart() {
    return state.cart.map((item) => ({ ...item, ...findVariant(item.productId, item.variantId) })).filter((item) => item.product && item.variant);
  }

  function cartSubtotal() {
    return detailedCart().reduce((sum, item) => sum + item.variant.price * item.quantity, 0);
  }

  function renderProducts() {
    if (!state.products.length) {
      productGrid.innerHTML = '<p class="cart-empty">Кофе пока нет в наличии.</p>';
      return;
    }
    productGrid.innerHTML = state.products.map((product) => {
      const available = product.variants.filter((variant) => variant.stock > 0);
      const options = available.map((variant) => `<option value="${escapeHtml(variant.id)}" data-price="${variant.price}">${variant.weight} г, ${money.format(variant.price)}</option>`).join("");
      return `<article class="product-card reveal in" data-product-id="${escapeHtml(product.id)}">
        <div><p class="product-notes">${escapeHtml(product.subtitle)}</p><h3>${escapeHtml(product.name)}</h3><p class="product-description">${escapeHtml(product.description)}</p></div>
        <div class="product-buy">
          <select aria-label="Вес пачки ${escapeHtml(product.name)}">${options}</select>
          <div class="price-line"><strong>${available[0] ? money.format(available[0].price) : "Нет в наличии"}</strong><span class="stock-note">Обжарим после заказа</span></div>
          <button class="btn add-to-cart" type="button" ${available.length ? "" : "disabled"}>Добавить в корзину</button>
        </div>
      </article>`;
    }).join("");

    productGrid.querySelectorAll(".product-card").forEach((card) => {
      const select = card.querySelector("select");
      const price = card.querySelector(".price-line strong");
      select.addEventListener("change", () => { price.textContent = money.format(Number(select.selectedOptions[0].dataset.price)); });
      card.querySelector(".add-to-cart").addEventListener("click", () => addToCart(card.dataset.productId, select.value));
    });
  }

  function addToCart(productId, variantId) {
    const existing = state.cart.find((item) => item.productId === productId && item.variantId === variantId);
    if (existing) existing.quantity = Math.min(10, existing.quantity + 1);
    else state.cart.push({ productId, variantId, quantity: 1 });
    saveCart(); renderCart(); openCart();
  }

  function changeQuantity(productId, variantId, delta) {
    const item = state.cart.find((entry) => entry.productId === productId && entry.variantId === variantId);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity <= 0) state.cart = state.cart.filter((entry) => entry !== item);
    item.quantity = Math.min(10, item.quantity);
    saveCart(); renderCart();
  }

  function renderCart() {
    const detailed = detailedCart();
    const count = detailed.reduce((sum, item) => sum + item.quantity, 0);
    $("#cartCount").textContent = String(count);
    $("#mobileCartCount").textContent = String(count);
    $("#cartTotal").textContent = money.format(cartSubtotal());
    cartItems.innerHTML = detailed.length ? detailed.map((item) => `<div class="cart-item">
      <div><strong>${escapeHtml(item.product.name)}</strong><div class="cart-meta">${item.variant.weight} г, ${money.format(item.variant.price)}</div></div>
      <strong>${money.format(item.variant.price * item.quantity)}</strong>
      <div class="quantity"><button type="button" data-action="minus" data-product="${escapeHtml(item.productId)}" data-variant="${escapeHtml(item.variantId)}" aria-label="Уменьшить">−</button><span>${item.quantity}</span><button type="button" data-action="plus" data-product="${escapeHtml(item.productId)}" data-variant="${escapeHtml(item.variantId)}" aria-label="Увеличить">+</button></div>
    </div>`).join("") : '<p class="cart-empty">Здесь пока пусто. Добавьте кофе из магазина.</p>';
    cartItems.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", () => changeQuantity(button.dataset.product, button.dataset.variant, button.dataset.action === "plus" ? 1 : -1)));
    renderCheckoutSummary();
  }

  function renderCheckoutSummary() {
    const detailed = detailedCart();
    const delivery = checkoutForm?.elements.fulfillment?.value === "delivery" ? 350 : 0;
    checkoutSummary.innerHTML = detailed.length ? `${detailed.map((item) => `<div class="summary-line"><span>${escapeHtml(item.product.name)}, ${item.variant.weight} г × ${item.quantity}</span><strong>${money.format(item.variant.price * item.quantity)}</strong></div>`).join("")}
      <div class="summary-line"><span>Получение</span><strong>${delivery ? money.format(delivery) : "Бесплатно"}</strong></div>
      <div class="summary-line summary-total"><span>Итого</span><strong>${money.format(cartSubtotal() + delivery)}</strong></div>` : '<p class="cart-empty">Корзина пока пуста.</p>';
  }

  function openCart() { cartDrawer.classList.add("is-open"); cartDrawer.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; requestAnimationFrame(() => $("#cartClose").focus()); }
  function closeCart() { cartDrawer.classList.remove("is-open"); cartDrawer.setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; }

  async function loadProducts() {
    try {
      const data = await request("/api/products"); state.products = data.products; renderProducts(); renderCart();
    } catch (error) { productGrid.innerHTML = `<p class="form-status is-error">${escapeHtml(error.message)}</p>`; }
  }

  function updateFulfillment() {
    const delivery = checkoutForm.elements.fulfillment.value === "delivery";
    $("#addressField").hidden = !delivery; $("#pickupField").hidden = delivery; $("#checkoutAddress").required = delivery; renderCheckoutSummary();
  }

  async function submitCheckout(event) {
    event.preventDefault(); checkoutStatus.className = "form-status";
    if (!state.cart.length) { checkoutStatus.textContent = "Сначала добавьте кофе в корзину."; checkoutStatus.classList.add("is-error"); return; }
    if (!checkoutForm.checkValidity()) { checkoutStatus.textContent = "Проверьте обязательные поля."; checkoutStatus.classList.add("is-error"); checkoutForm.reportValidity(); return; }
    const button = checkoutForm.querySelector("button[type=submit]"); const form = new FormData(checkoutForm); button.disabled = true; button.textContent = "Создаём заказ...";
    try {
      const created = await request("/api/orders", { method: "POST", body: JSON.stringify({
        items: state.cart, customer: { name: form.get("name"), phone: form.get("phone"), email: form.get("email") }, fulfillment: form.get("fulfillment"), address: form.get("address"), pickupTime: form.get("pickupTime"), comment: form.get("comment")
      }) });
      checkoutStatus.textContent = `Заказ ${created.order.number} создан. Переходим к оплате.`; checkoutStatus.classList.add("is-success");
      const payment = await request("/api/payments", { method: "POST", body: JSON.stringify({ orderId: created.order.id, accessToken: created.accessToken }) });
      localStorage.setItem("tishe_last_order", JSON.stringify({ id: created.order.id, token: created.accessToken, number: created.order.number }));
      state.cart = []; saveCart(); renderCart(); window.location.href = payment.paymentUrl;
    } catch (error) { checkoutStatus.textContent = error.message; checkoutStatus.classList.add("is-error"); button.disabled = false; button.textContent = "Создать заказ и оплатить"; }
  }

  function setAuthTab(tab) {
    document.querySelectorAll("[data-auth-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.authTab === tab));
    $("#loginForm").hidden = tab !== "login"; $("#registerForm").hidden = tab !== "register"; $("#authStatus").textContent = "";
  }

  function fillCheckoutFromUser() {
    if (!state.user) return;
    $("#checkoutName").value ||= state.user.name || ""; $("#checkoutPhone").value ||= state.user.phone || ""; $("#checkoutEmail").value ||= state.user.email || "";
  }

  async function refreshAccount() {
    try { state.user = (await request("/api/auth/me")).user; } catch { state.user = null; }
    $("#accountButton").textContent = state.user ? state.user.name : "Войти";
    $("#mobileAccountLabel").textContent = state.user ? "Профиль" : "Войти";
    $("#authArea").hidden = Boolean(state.user); $("#profileArea").hidden = !state.user;
    if (!state.user) return;
    $("#profileGreeting").textContent = `${state.user.name}, здесь появятся ваши заказы.`; fillCheckoutFromUser();
    try {
      const { orders } = await request("/api/orders");
      $("#accountOrders").innerHTML = orders.length ? orders.map((order) => `<article class="account-order"><strong>${escapeHtml(order.number)} · ${money.format(order.total)}</strong><p>${statusLabel(order.status)}, оплата: ${order.paymentStatus === "paid" ? "оплачено" : "ожидается"}</p></article>`).join("") : '<p class="cart-empty">Заказов пока нет.</p>';
    } catch { $("#accountOrders").innerHTML = ""; }
  }

  function statusLabel(status) {
    return ({ new: "Новый", confirmed: "Подтверждён", accepted: "Принят", preparing: "Готовится", ready: "Готов", completed: "Выполнен", cancelled: "Отменён" })[status] || status;
  }

  async function submitAuth(event, endpoint) {
    event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); const status = $("#authStatus"); status.className = "form-status";
    try { await request(endpoint, { method: "POST", body: JSON.stringify(data) }); form.reset(); status.textContent = "Готово."; status.classList.add("is-success"); await refreshAccount(); }
    catch (error) { status.textContent = error.message; status.classList.add("is-error"); }
  }

  function openAccount() { refreshAccount(); accountDialog.showModal(); }

  $("#cartButton").addEventListener("click", openCart); $("#mobileCartButton").addEventListener("click", openCart); $("#cartClose").addEventListener("click", closeCart); $("#cartBackdrop").addEventListener("click", closeCart);
  $("#checkoutLink").addEventListener("click", closeCart);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && cartDrawer.classList.contains("is-open")) closeCart(); });
  checkoutForm.addEventListener("submit", submitCheckout); checkoutForm.querySelectorAll("input[name=fulfillment]").forEach((input) => input.addEventListener("change", updateFulfillment));
  $("#accountButton").addEventListener("click", openAccount); $("#mobileAccountButton").addEventListener("click", openAccount); $("#accountClose").addEventListener("click", () => accountDialog.close());
  document.querySelectorAll("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => setAuthTab(button.dataset.authTab)));
  $("#loginForm").addEventListener("submit", (event) => submitAuth(event, "/api/auth/login")); $("#registerForm").addEventListener("submit", (event) => submitAuth(event, "/api/auth/register"));
  $("#logoutButton").addEventListener("click", async () => { await request("/api/auth/logout", { method: "POST", body: "{}" }); state.user = null; await refreshAccount(); });

  const mobileSectionLinks = [...document.querySelectorAll("[data-mobile-section]")];
  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    mobileSectionLinks.forEach((link) => link.classList.toggle("is-active", link.dataset.mobileSection === visible.target.id));
  }, { rootMargin: "-28% 0px -56%", threshold: [0, .25, .6] });
  [$("#top"), $("#shop")].forEach((section) => sectionObserver.observe(section));

  updateFulfillment(); loadProducts(); refreshAccount();
})();
