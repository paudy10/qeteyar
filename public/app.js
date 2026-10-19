'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const numberFmt = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 2 });
const integerFmt = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 });
const jalaliFormatter = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const jalaliTehranFormatter = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' });
const state = { username: 'admin', rate: null, refs: { categories: [], brands: [], technicians: [], suppliers: [] }, products: [], priceSearchResults: [], dashboard: null, report: null, activeView: 'dashboard' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function formatNumber(value) { return numberFmt.format(Number(value || 0)); }
function formatUsd(value) { return '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(Number(value || 0)); }
function formatRial(value) { return formatNumber(value) + ' ریال'; }
function formatRialCompact(value) { return numberFmt.format(Number(value || 0)); }
function localizeDigits(s) { return String(s).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))); }
function partsToObj(parts) { return Object.fromEntries(parts.map(p => [p.type, p.value])); }
function jParts(date, formatter = jalaliTehranFormatter) {
  const o = partsToObj(formatter.formatToParts(date));
  return { year: Number(o.year), month: Number(o.month), day: Number(o.day) };
}
function jalaliString(date) {
  const p = jParts(date);
  return `${p.year}/${String(p.month).padStart(2, '0')}/${String(p.day).padStart(2, '0')}`;
}
function todayJalali() { return jalaliString(new Date()); }
function jalaliToGregorian(input) {
  const cleaned = localizeDigits(String(input || '').trim()).replace(/[.\-]/g, '/');
  const match = cleaned.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) throw new Error('تاریخ را به شکل سال/ماه/روز وارد کنید؛ مانند ۱۴۰۵/۰۷/۰۱.');
  const target = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (target.month < 1 || target.month > 12 || target.day < 1 || target.day > 31) throw new Error('تاریخ شمسی معتبر نیست.');
  const targetKey = target.year * 10000 + target.month * 100 + target.day;
  let lo = Math.floor(Date.UTC(target.year + 620, 0, 1) / 86400000);
  let hi = Math.floor(Date.UTC(target.year + 623, 0, 1) / 86400000);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const date = new Date(mid * 86400000);
    const p = jParts(date, jalaliFormatter);
    const key = p.year * 10000 + p.month * 100 + p.day;
    if (key === targetKey) return date.toISOString().slice(0, 10);
    if (key < targetKey) lo = mid + 1; else hi = mid - 1;
  }
  throw new Error('این تاریخ در تقویم شمسی معتبر نیست.');
}
function formatGregorianDate(dateText) {
  if (!dateText) return '—';
  const d = new Date(`${dateText}T12:00:00Z`);
  return jalaliString(d);
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function todayHeader() {
  $('#topDate').textContent = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
}
async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { 'Accept': 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }, credentials: 'same-origin' };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(path, init);
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') showLogin();
    throw new Error(data.error || `خطا (${res.status})`);
  }
  return data;
}
function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '✓' : '!'}</span><div>${escapeHtml(message)}</div>`;
  $('#toastHost').append(el);
  setTimeout(() => el.remove(), 4400);
}
function showLogin() {
  $('#appShell').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
}
function showApp(username) {
  state.username = username || 'مدیر';
  $('#currentUser').textContent = state.username;
  $('#loginScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  todayHeader();
}
function setRate(rate) {
  state.rate = rate;
  const sidebar = $('#sidebarRate');
  const top = $('#topRate');
  if (!rate || !rate.price) {
    sidebar.textContent = 'در دسترس نیست'; top.textContent = '—';
    $('#rateWarning').textContent = rate?.warning || 'نرخ دلار در دسترس نیست.';
    $('#rateWarning').classList.remove('hidden');
  } else {
    const value = `${formatRialCompact(rate.price)} ریال`;
    sidebar.textContent = value; top.textContent = value;
    if (rate.warning || rate.stale) {
      $('#rateWarning').textContent = rate.warning || 'نرخ ذخیره‌شده نمایش داده می‌شود.';
      $('#rateWarning').classList.remove('hidden');
    } else $('#rateWarning').classList.add('hidden');
  }
  updateTransactionPreviews();
  updateProductPricePreviews();
  if (state.products.length) renderProducts();
  renderPriceSearchResults();
}
function populateSelect(el, items, placeholder = 'انتخاب کنید…', selected = '') {
  if (!el) return;
  const first = `<option value="">${escapeHtml(placeholder)}</option>`;
  el.innerHTML = first + items.map(item => `<option value="${item.id}" ${String(item.id) === String(selected) ? 'selected' : ''}>${escapeHtml(item.name)}${item.kind ? (item.kind === 'supplier' ? ' · تأمین‌کننده' : ' · قطعه‌فروش') : ''}</option>`).join('');
}
function refName(table, id) { return (state.refs[table] || []).find(x => String(x.id) === String(id))?.name || ''; }
function productLabel(p) { return `${p.name}${p.model ? ' · ' + p.model : ''}${p.brand_name ? ' · ' + p.brand_name : ''}`; }
function setupReferenceSelects() {
  const r = state.refs;
  populateSelect($('#productCategory'), r.categories, 'بدون دسته‌بندی');
  populateSelect($('#productBrand'), r.brands, 'بدون برند');
  populateSelect($('#directCategory'), r.categories, 'انتخاب دسته');
  populateSelect($('#directBrand'), r.brands, 'انتخاب برند');
  populateSelect($('#editCategory'), r.categories, 'بدون دسته‌بندی');
  populateSelect($('#editBrand'), r.brands, 'بدون برند');
  populateSelect($('#stockSupplier'), r.suppliers, 'انتخاب تأمین‌کننده (اختیاری)');
  populateSelect($('#directSupplier'), r.suppliers, 'انتخاب قطعه‌فروش / تأمین‌کننده');
  populateSelect($('#saleTechnician'), r.technicians, 'انتخاب تعمیرکار');
  populateSelect($('#directTechnician'), r.technicians, 'انتخاب تعمیرکار');
  populateSelect($('#reportTechnician'), r.technicians, 'همه تعمیرکاران');
  populateSelect($('#reportBrand'), r.brands, 'همه برندها');
  populateSelect($('#reportCategory'), r.categories, 'همه دسته‌ها');
  populateSelect($('#reportSupplier'), r.suppliers, 'همه طرف حساب‌ها');
  refreshProductSelects();
  renderPeople();
}
async function loadReferences() {
  const tables = ['categories', 'brands', 'technicians', 'suppliers'];
  const data = await Promise.all(tables.map(t => api(`/api/${t}`)));
  tables.forEach((t, i) => state.refs[t] = data[i]);
  setupReferenceSelects();
}
async function loadProducts(q = '') {
  state.products = await api(`/api/products${q ? '?q=' + encodeURIComponent(q) : ''}`);
  renderProducts(); refreshProductSelects(); renderLowStock(); updateTransactionPreviews();
}
function refreshProductSelects() {
  const stockProducts = state.products.filter(p => p.mode === 'stock');
  const directProducts = state.products.filter(p => p.mode === 'direct');
  populateProductSelect($('#stockProduct'), stockProducts, 'انتخاب محصول برای شارژ');
  populateProductSelect($('#saleProduct'), stockProducts.filter(p => Number(p.stock_qty) > 0), 'انتخاب محصول موجود');
  // This select is kept as reference context for future direct-use autocomplete; direct-use accepts free text.
  void directProducts;
}
function populateProductSelect(el, items, placeholder) {
  if (!el) return;
  const current = el.value;
  el.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + items.map(p => `<option value="${p.id}" data-price="${Number(p.default_usd_price)}" data-stock="${Number(p.stock_qty)}">${escapeHtml(productLabel(p))} — موجودی: ${formatNumber(p.stock_qty)}</option>`).join('');
  if (items.some(x => String(x.id) === current)) el.value = current;
}
function activeProduct(productId) { return state.products.find(x => String(x.id) === String(productId)); }
function renderProducts() {
  const host = $('#productsTable');
  if (!host) return;
  const products = state.products;
  $('#productCount').textContent = `${formatNumber(products.length)} محصول`;
  if (!products.length) { host.innerHTML = '<div class="table-empty">محصولی پیدا نشد. از دکمه «محصول جدید» برای تعریف قطعه استفاده کنید.</div>'; return; }
  host.innerHTML = `<table class="data-table"><thead><tr><th>محصول / کد</th><th>دسته و برند</th><th>نوع</th><th>موجودی</th><th>قیمت پایه (ریال)</th><th>معادل دلاری ذخیره‌شده</th><th>ارزش به نرخ روز</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${products.map(p => {
    const isLow = p.mode === 'stock' && Number(p.stock_qty) <= Number(p.min_stock);
    const live = Number(state.rate?.price || 0) * Number(p.default_usd_price || 0);
    return `<tr><td><div class="primary-cell">${escapeHtml(p.name)}</div><span class="secondary-cell">${escapeHtml(p.model || p.sku)} · ${escapeHtml(p.sku)}</span></td><td><div>${escapeHtml(p.category_name || '—')}</div><span class="secondary-cell">${escapeHtml(p.brand_name || 'بدون برند')}</span></td><td><span class="badge ${p.mode}">${p.mode === 'stock' ? 'انباری' : 'مصرف مستقیم'}</span></td><td>${p.mode === 'stock' ? formatNumber(p.stock_qty) : '—'}${p.mode === 'stock' ? `<span class="secondary-cell">حد هشدار: ${formatNumber(p.min_stock)}</span>` : ''}</td><td>${formatRialCompact(p.default_irr_price || 0)} ریال</td><td>${formatUsd(p.default_usd_price)}</td><td>${state.rate?.price ? formatRialCompact(live) + ' ریال' : '—'}</td><td><span class="badge ${isLow ? 'low' : 'ok'}">${isLow ? 'نیاز به شارژ' : 'عادی'}</span></td><td><div class="row-actions"><button class="mini-action" data-edit-product="${p.id}">ویرایش</button><button class="mini-action danger" data-archive-product="${p.id}">غیرفعال</button></div></td></tr>`;
  }).join('')}</tbody></table>`;
}
function movementKind(kind) {
  return ({ stock_in: 'ورود به انبار', sale: 'فروش / مصرف انبار', direct_use: 'تأمین و مصرف مستقیم' })[kind] || kind;
}
function kindBadge(kind) { return `<span class="badge ${escapeHtml(kind)}">${escapeHtml(movementKind(kind))}</span>`; }
function recentMovementHtml(m) {
  const symbol = m.kind === 'stock_in' ? '↙' : m.kind === 'sale' ? '↗' : '⇄';
  const sub = [m.technician_name_snapshot, m.supplier_name_snapshot].filter(Boolean).join(' · ') || (m.kind === 'stock_in' ? 'ورود به انبار' : 'بدون طرف حساب');
  return `<div class="recent-item"><div class="recent-symbol ${escapeHtml(m.kind)}">${symbol}</div><div class="recent-details"><strong>${escapeHtml(m.item_name_snapshot)}</strong><small>${escapeHtml(movementKind(m.kind))} · ${escapeHtml(sub)}</small></div><div class="recent-amount"><strong>${formatRialCompact(m.total_irr)} ریال</strong><small>${formatDateTime(m.created_at)}</small></div></div>`;
}
async function loadDashboard() {
  const d = await api('/api/dashboard');
  state.dashboard = d;
  setRate(d.rate);
  $('#statProducts').textContent = formatNumber(d.stats.products_count || 0);
  $('#statUnits').textContent = formatNumber(d.stats.stock_units || 0);
  $('#statLow').textContent = formatNumber(d.stats.low_stock_count || 0);
  $('#statToday').textContent = formatRialCompact(d.stats.today_total_irr || 0);
  $('#recentMovements').innerHTML = d.latest.length ? d.latest.map(recentMovementHtml).join('') : '<div class="empty-state">هنوز فعالیتی ثبت نشده است.</div>';
  renderLowStock();
}
function renderLowStock() {
  const host = $('#lowStockTable');
  if (!host) return;
  const low = state.products.filter(p => p.mode === 'stock' && Number(p.stock_qty) <= Number(p.min_stock)).slice(0, 8);
  if (!low.length) { host.innerHTML = '<div class="table-empty">در حال حاضر محصولی در محدوده هشدار موجودی نیست.</div>'; return; }
  host.innerHTML = `<table class="data-table"><thead><tr><th>نام محصول</th><th>دسته</th><th>برند</th><th>موجودی فعلی</th><th>حد هشدار</th><th>وضعیت</th><th>اقدام</th></tr></thead><tbody>${low.map(p => `<tr><td class="primary-cell">${escapeHtml(p.name)}</td><td>${escapeHtml(p.category_name || '—')}</td><td>${escapeHtml(p.brand_name || '—')}</td><td>${formatNumber(p.stock_qty)}</td><td>${formatNumber(p.min_stock)}</td><td><span class="badge low">نیاز به شارژ</span></td><td><button class="mini-action" data-stock-product="${p.id}">شارژ کالا</button></td></tr>`).join('')}</tbody></table>`;
}
function renderPeople() {
  $('#techniciansList').innerHTML = state.refs.technicians.length ? state.refs.technicians.map(t => `<div class="mini-list-item"><div><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(t.phone || 'شماره تماس ثبت نشده')}</small></div><span class="badge ok">فعال</span></div>`).join('') : '<div class="empty-state">هنوز تعمیرکاری ثبت نشده است.</div>';
  $('#suppliersList').innerHTML = state.refs.suppliers.length ? state.refs.suppliers.map(s => `<div class="mini-list-item"><div><strong>${escapeHtml(s.name)}</strong><small>${s.kind === 'supplier' ? 'تأمین‌کننده' : 'قطعه‌فروش'}${s.phone ? ' · ' + escapeHtml(s.phone) : ''}</small></div><span class="badge ${s.kind === 'supplier' ? 'sale' : 'direct_use'}">${s.kind === 'supplier' ? 'تأمین' : 'فروشنده'}</span></div>`).join('') : '<div class="empty-state">هنوز طرف حسابی ثبت نشده است.</div>';
  $('#categoriesList').innerHTML = state.refs.categories.map(c => `<span class="soft-pill">${escapeHtml(c.name)}</span>`).join('');
  $('#brandsList').innerHTML = state.refs.brands.map(b => `<span class="soft-pill">${escapeHtml(b.name)}</span>`).join('');
}
function switchView(view) {
  const valid = ['dashboard','products','price-search','stockin','sales','direct','people','reports'];
  if (!valid.includes(view)) return;
  state.activeView = view;
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `${view}View`));
  $$('.nav-link[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const titles = { dashboard: 'نمای کلی', products: 'محصولات و موجودی', 'price-search': 'جست‌وجو و قیمت', stockin: 'شارژ انبار', sales: 'فروش و مصرف انبار', direct: 'تأمین و مصرف مستقیم', people: 'تعمیرکاران و طرف حساب', reports: 'گزارش‌ها' };
  $('#pageTitle').textContent = titles[view];
  if (view === 'reports' && !state.report) loadReport();
  if (view === 'products') loadProducts($('#productSearch').value.trim()).catch(err => toast(err.message, 'error'));
  if (view === 'price-search' && !state.priceSearchResults.length) searchPrices($('#priceSearchInput').value.trim()).catch(err => toast(err.message, 'error'));
}
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function resetForm(form) { form.reset(); }
function productPrice(productId) {
  const p = state.products.find(x => String(x.id) === String(productId));
  return Number(p?.default_usd_price || 0) * Number(state.rate?.price || 0);
}
function transactionTotalPreview(quantityInput, priceInput, preview, getDefaultPrice = () => 0, prefix = 'مبلغ') {
  if (!preview) return;
  const qty = Number(quantityInput?.value || 0);
  const rawPrice = priceInput?.value;
  const unitIrr = rawPrice === '' || rawPrice == null ? Number(getDefaultPrice() || 0) : Number(rawPrice || 0);
  const fx = Number(state.rate?.price || 0);
  if (!qty || unitIrr < 0 || !fx) { preview.textContent = fx ? 'تعداد را وارد کنید؛ قیمت خالی یعنی استفاده از قیمت لحظه‌ای محصول.' : 'برای محاسبه قیمت، نرخ دلار باید در دسترس باشد.'; return; }
  const usdUnit = unitIrr / fx;
  const usdTotal = qty * usdUnit;
  const rialTotal = qty * unitIrr;
  preview.innerHTML = `${escapeHtml(prefix)}: <strong>${formatNumber(qty)} × ${formatRialCompact(unitIrr)} ریال</strong> <span class="preview-total">${formatRial(rialTotal)}</span><div class="secondary-cell">معادل هر عدد: ${formatUsd(usdUnit)} · جمع دلاری: ${formatUsd(usdTotal)} · نرخ: ${formatRialCompact(fx)} ریال</div>`;
}
function updateDirectPreview() {
  const preview = $('#directPreview');
  if (!preview) return;
  const qty = Number($('#directForm [name="quantity"]').value || 0);
  const buy = Number($('#directPurchasePrice').value || 0);
  const useRaw = $('#directUsePrice').value;
  const use = useRaw === '' ? buy : Number(useRaw || 0);
  const fx = Number(state.rate?.price || 0);
  if (!qty || !fx || !$('#directPurchasePrice').value) {
    preview.textContent = fx ? 'قیمت خرید و تعداد را وارد کنید تا معادل دلاری و جمع‌ها محاسبه شوند.' : 'نرخ دلار برای محاسبه معادل دلاری در دسترس نیست.';
    return;
  }
  preview.innerHTML = `<div><strong>خرید از قطعه‌فروش:</strong> ${formatNumber(qty)} × ${formatRialCompact(buy)} ریال = <strong>${formatRial(qty * buy)}</strong><div class="secondary-cell">معادل خرید: ${formatUsd(buy / fx)} برای هر عدد · جمع ${formatUsd(qty * buy / fx)}</div></div><div class="direct-use-price-preview"><strong>قیمت زمان استفاده / فروش:</strong> ${formatNumber(qty)} × ${formatRialCompact(use)} ریال = <strong>${formatRial(qty * use)}</strong><div class="secondary-cell">معادل زمان استفاده: ${formatUsd(use / fx)} برای هر عدد · نرخ دلار: ${formatRialCompact(fx)} ریال</div></div>`;
}
function updateProductPricePreviews() {
  const fx = Number(state.rate?.price || 0);
  const productPrice = Number($('#productForm [name="default_irr_price"]')?.value || 0);
  const editPrice = Number($('#editProductPrice')?.value || 0);
  if ($('#productPriceUsdPreview')) $('#productPriceUsdPreview').textContent = fx ? `معادل ذخیره‌شده: ${formatUsd(productPrice / fx)}` : 'برای محاسبه معادل دلاری، نرخ دلار لازم است.';
  if ($('#editProductPriceUsdPreview')) $('#editProductPriceUsdPreview').textContent = fx ? `معادل ذخیره‌شده: ${formatUsd(editPrice / fx)}` : 'برای محاسبه معادل دلاری، نرخ دلار لازم است.';
}
function updateTransactionPreviews() {
  const stockProductId = $('#stockProduct')?.value;
  transactionTotalPreview($('#stockInForm [name="quantity"]'), $('#stockPrice'), $('#stockPreview'), () => productPrice(stockProductId), 'ارزش ورود');
  const saleProductId = $('#saleProduct')?.value;
  transactionTotalPreview($('#saleForm [name="quantity"]'), $('#salePrice'), $('#salePreview'), () => productPrice(saleProductId), 'ارزش خروج');
  updateDirectPreview();
  updateProductPricePreviews();
}
function renderPriceSearchResults() {
  const host = $('#priceSearchResults');
  if (!host) return;
  const items = state.priceSearchResults || [];
  $('#priceSearchCount').textContent = `${formatNumber(items.length)} نتیجه`;
  if (!items.length) { host.innerHTML = '<div class="empty-state">محصولی با این مشخصات پیدا نشد. عبارت دیگری را امتحان کنید.</div>'; return; }
  const fx = Number(state.rate?.price || 0);
  host.innerHTML = `<table class="data-table"><thead><tr><th>قطعه</th><th>برند / دسته</th><th>موجودی</th><th>معادل دلاری</th><th>قیمت روز به ریال</th><th>وضعیت</th></tr></thead><tbody>${items.map(p => {
    const live = Number(p.default_usd_price || 0) * fx;
    const low = p.mode === 'stock' && Number(p.stock_qty) <= Number(p.min_stock);
    return `<tr><td><div class="primary-cell">${escapeHtml(p.name)}</div><span class="secondary-cell">${escapeHtml([p.model, p.sku].filter(Boolean).join(' · '))}</span></td><td>${escapeHtml(p.brand_name || '—')}<span class="secondary-cell">${escapeHtml(p.category_name || 'بدون دسته')}</span></td><td>${p.mode === 'stock' ? formatNumber(p.stock_qty) : 'مصرف مستقیم'}</td><td>${formatUsd(p.default_usd_price)}</td><td><strong>${fx ? formatRialCompact(live) + ' ریال' : 'نرخ در دسترس نیست'}</strong></td><td><span class="badge ${low ? 'low' : 'ok'}">${low ? 'نیاز به شارژ' : (p.mode === 'direct' ? 'مصرف مستقیم' : 'عادی')}</span></td></tr>`;
  }).join('')}</tbody></table>`;
}
async function searchPrices(q = '') {
  state.priceSearchResults = await api(`/api/products${q ? '?q=' + encodeURIComponent(q) : ''}`);
  renderPriceSearchResults();
}

function setFormBusy(form, busy) { const btn = $('button[type="submit"]', form); if (btn) { btn.disabled = busy; btn.dataset.originalText ||= btn.textContent; btn.textContent = busy ? 'در حال ثبت…' : btn.dataset.originalText; } }
async function handleForm(form, path, onSuccess, transform = x => x) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    setFormBusy(form, true);
    try {
      const payload = transform(formObject(form));
      await api(path, { method: 'POST', body: payload });
      toast('اطلاعات با موفقیت ثبت شد.');
      form.reset();
      await onSuccess?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setFormBusy(form, false); }
  });
}
function openEditProduct(id) {
  const p = activeProduct(id); if (!p) return;
  const form = $('#editProductForm');
  form.elements.id.value = p.id;
  form.elements.name.value = p.name;
  form.elements.model.value = p.model || '';
  form.elements.details.value = p.details || '';
  form.elements.category_id.value = p.category_id || '';
  form.elements.brand_id.value = p.brand_id || '';
  form.elements.default_irr_price.value = p.default_irr_price || Math.round(Number(p.default_usd_price || 0) * Number(state.rate?.price || 0));
  updateProductPricePreviews();
  form.elements.min_stock.value = p.min_stock;
  $('#editProductModal').classList.remove('hidden');
}
async function saveEditedProduct(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const id = form.elements.id.value;
  const payload = formObject(form); delete payload.id;
  payload.category_id ||= null; payload.brand_id ||= null;
  payload.default_irr_price = Number(payload.default_irr_price); payload.min_stock = Number(payload.min_stock || 0);
  try {
    await api(`/api/products/${id}`, { method: 'PATCH', body: payload });
    $('#editProductModal').classList.add('hidden'); toast('تغییرات محصول ذخیره شد.');
    await Promise.all([loadProducts($('#productSearch').value.trim()), loadDashboard()]);
  } catch (err) { toast(err.message, 'error'); }
}
async function archiveProduct(id) {
  const p = activeProduct(id); if (!p) return;
  if (!confirm(`محصول «${p.name}» غیرفعال شود؟ سوابق قبلی حذف نمی‌شوند.`)) return;
  try { await api(`/api/products/${id}`, { method: 'DELETE' }); toast('محصول غیرفعال شد.'); await Promise.all([loadProducts($('#productSearch').value.trim()), loadDashboard()]); }
  catch (err) { toast(err.message, 'error'); }
}

function initReportDates() {
  const today = jParts(new Date());
  $('#reportFrom').value = `${today.year}/${String(today.month).padStart(2,'0')}/01`;
  $('#reportTo').value = todayJalali();
  $('#printGenerated').textContent = `زمان تهیه: ${formatDateTime(new Date().toISOString())}`;
}
function reportFilterLabel(data) {
  const bits = [];
  if (data.filters.from) bits.push(`از ${formatGregorianDate(data.filters.from)}`);
  if (data.filters.to) bits.push(`تا ${formatGregorianDate(data.filters.to)}`);
  if (data.filters.kind) bits.push(movementKind(data.filters.kind));
  if (data.filters.technician_id) bits.push(`تعمیرکار: ${refName('technicians', data.filters.technician_id)}`);
  if (data.filters.brand_id) bits.push(`برند: ${refName('brands', data.filters.brand_id)}`);
  if (data.filters.category_id) bits.push(`دسته: ${refName('categories', data.filters.category_id)}`);
  if (data.filters.supplier_id) bits.push(`طرف حساب: ${refName('suppliers', data.filters.supplier_id)}`);
  return bits.length ? bits.join(' · ') : 'همه عملیات ثبت‌شده';
}
async function loadReport(filters = {}) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value !== '' && value != null) query.set(key, value); });
  const data = await api('/api/reports' + (query.size ? `?${query}` : ''));
  state.report = data;
  $('#reportPrintSubtitle').textContent = reportFilterLabel(data);
  $('#printGenerated').textContent = `زمان تهیه: ${formatDateTime(new Date().toISOString())}`;
  const s = data.summary;
  $('#reportSummary').innerHTML = `<div class="summary-box"><small>تعداد عملیات</small><strong>${formatNumber(s.count)}</strong></div><div class="summary-box"><small>مجموع تعداد قطعات</small><strong>${formatNumber(s.quantity)}</strong></div><div class="summary-box"><small>جمع قیمت خرید</small><strong>${formatRialCompact(s.total_purchase_irr)} ریال</strong></div><div class="summary-box"><small>جمع فروش / استفاده</small><strong>${formatRialCompact(s.total_irr)} ریال</strong></div>`;
  const host = $('#reportTable');
  if (!data.rows.length) host.innerHTML = '<div class="empty-state">برای فیلترهای انتخاب‌شده نتیجه‌ای ثبت نشده است.</div>';
  else host.innerHTML = `<table class="data-table"><thead><tr><th>تاریخ شمسی</th><th>عملیات</th><th>نام قطعه</th><th>دسته / برند</th><th>تعداد</th><th>قیمت واحد خرید</th><th>قیمت واحد فروش / استفاده</th><th>جمع خرید</th><th>جمع فروش / استفاده</th><th>نرخ دلار خرید / عملیات</th><th>تعمیرکار</th><th>قطعه‌فروش / تأمین‌کننده</th><th>توضیحات</th></tr></thead><tbody>${data.rows.map(r => `<tr><td>${escapeHtml(formatDateTime(r.created_at))}</td><td>${kindBadge(r.kind)}</td><td class="primary-cell">${escapeHtml(r.item_name_snapshot)}</td><td>${escapeHtml([r.category_name_snapshot,r.brand_name_snapshot].filter(Boolean).join(' / ') || '—')}</td><td>${formatNumber(r.quantity)}</td><td><strong>${formatRialCompact(r.purchase_irr_unit_price || r.irr_unit_price)} ریال</strong><small class="report-subvalue">${formatUsd(r.purchase_usd_unit_price || r.usd_unit_price)}</small></td><td><strong>${formatRialCompact(r.irr_unit_price)} ریال</strong><small class="report-subvalue">${formatUsd(r.usd_unit_price)}</small></td><td>${formatRialCompact(r.purchase_total_irr || r.total_irr)} ریال</td><td>${formatRialCompact(r.total_irr)} ریال</td><td><small>خرید: ${formatRialCompact(r.purchase_irr_rate)} ریال</small><br><small>عملیات: ${formatRialCompact(r.irr_rate)} ریال</small></td><td>${escapeHtml(r.technician_name_snapshot || '—')}</td><td>${escapeHtml(r.supplier_name_snapshot || '—')}</td><td>${escapeHtml(r.note || '—')}</td></tr>`).join('')}</tbody></table>${data.truncated ? '<div class="warning-banner">تعداد نتایج بیشتر از سقف نمایش است؛ فیلترهای تاریخ را محدودتر کنید.</div>' : ''}`;
}
async function applyReportFilters(e) {
  e?.preventDefault();
  const fromText = $('#reportFrom').value.trim();
  const toText = $('#reportTo').value.trim();
  const filters = { kind: $('#reportKind').value, technician_id: $('#reportTechnician').value, brand_id: $('#reportBrand').value, category_id: $('#reportCategory').value, supplier_id: $('#reportSupplier').value };
  try {
    if (fromText) filters.from = jalaliToGregorian(fromText);
    if (toText) filters.to = jalaliToGregorian(toText);
    if (filters.from && filters.to && filters.from > filters.to) throw new Error('تاریخ شروع نباید بعد از تاریخ پایان باشد.');
    await loadReport(filters);
  } catch (err) { toast(err.message, 'error'); }
}

function initEvents() {
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget; const button = $('button[type="submit"]', form); button.disabled = true; $('#loginError').textContent = '';
    try {
      const data = await api('/api/login', { method: 'POST', body: formObject(form) });
      showApp(data.username); await initializeData();
    } catch (err) { $('#loginError').textContent = err.message; }
    finally { button.disabled = false; }
  });
  $('#logoutBtn').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: {} }); } catch {} showLogin(); });
  const openChangePassword = () => $('#changePasswordModal').classList.remove('hidden');
  $('#changePasswordBtn').addEventListener('click', openChangePassword);
  $('#changePasswordForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget; const payload = formObject(form);
    if (payload.newPassword !== payload.confirmPassword) return toast('تکرار رمز جدید مطابقت ندارد.', 'error');
    const btn = $('button[type="submit"]', form); btn.disabled = true;
    try { await api('/api/change-password', { method: 'POST', body: { currentPassword: payload.currentPassword, newPassword: payload.newPassword } }); form.reset(); $('#changePasswordModal').classList.add('hidden'); toast('رمز عبور با موفقیت تغییر کرد.'); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  });
  $$('.nav-link[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $$('[data-goto]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.goto)));
  $$('[data-close]').forEach(btn => btn.addEventListener('click', () => $(`#${btn.dataset.close}`).classList.add('hidden')));
  $('#toggleProductForm').addEventListener('click', () => { $('#productForm').classList.toggle('hidden'); updateProductPricePreviews(); });
  $('#productForm [name="mode"]').addEventListener('change', e => $$('.stock-only').forEach(el => el.classList.toggle('hidden', e.target.value !== 'stock')));
  $('#productSearch').addEventListener('input', async e => { try { await loadProducts(e.target.value.trim()); } catch (err) { toast(err.message, 'error'); } });
  $('#refreshProducts').addEventListener('click', () => loadProducts($('#productSearch').value.trim()).catch(err => toast(err.message,'error')));
  $('#productsTable').addEventListener('click', e => {
    const edit = e.target.closest('[data-edit-product]'); const archive = e.target.closest('[data-archive-product]');
    if (edit) openEditProduct(edit.dataset.editProduct);
    if (archive) archiveProduct(archive.dataset.archiveProduct);
  });
  $('#lowStockTable').addEventListener('click', e => { const btn = e.target.closest('[data-stock-product]'); if (btn) { switchView('stockin'); $('#stockProduct').value = btn.dataset.stockProduct; $('#stockPrice').value = ''; updateTransactionPreviews(); } });
  $('#editProductForm').addEventListener('submit', saveEditedProduct);
  $('#archiveProductBtn').addEventListener('click', async () => { const id = $('#editProductForm').elements.id.value; $('#editProductModal').classList.add('hidden'); await archiveProduct(id); });
  $('#refreshRateBtn').addEventListener('click', async () => { const btn = $('#refreshRateBtn'); btn.disabled = true; try { const rate = await api('/api/rate?refresh=1'); setRate(rate); toast(rate.price ? 'نرخ ارز به‌روزرسانی شد.' : rate.warning, rate.price ? 'success' : 'error'); } catch (err) { toast(err.message,'error'); } finally { btn.disabled = false; } });
  ['stockProduct','saleProduct'].forEach(id => $(`#${id}`).addEventListener('change', () => { const price = id === 'stockProduct' ? $('#stockPrice') : $('#salePrice'); price.value = ''; updateTransactionPreviews(); }));
  ['stockPrice','salePrice','directPurchasePrice','directUsePrice'].forEach(id => $(`#${id}`).addEventListener('input', updateTransactionPreviews));
  $('#productForm [name="default_irr_price"]').addEventListener('input', updateProductPricePreviews);
  $('#editProductPrice').addEventListener('input', updateProductPricePreviews);
  let priceSearchTimer;
  $('#priceSearchInput').addEventListener('input', () => { clearTimeout(priceSearchTimer); priceSearchTimer = setTimeout(() => searchPrices($('#priceSearchInput').value.trim()).catch(err => toast(err.message, 'error')), 180); });
  $('#priceSearchRefresh').addEventListener('click', async () => { try { await searchPrices($('#priceSearchInput').value.trim()); toast('فهرست قیمت به‌روز شد.'); } catch (err) { toast(err.message, 'error'); } });
  ['stockInForm','saleForm','directForm'].forEach(id => { const form = $(`#${id}`); form.addEventListener('input', updateTransactionPreviews); });
  handleForm($('#productForm'), '/api/products', async () => { $('#productForm').classList.add('hidden'); await loadProducts(); await loadDashboard(); await searchPrices($('#priceSearchInput').value.trim()); }, body => ({ ...body, category_id: body.category_id || null, brand_id: body.brand_id || null, default_irr_price: Number(body.default_irr_price), stock_qty: Number(body.stock_qty || 0), min_stock: Number(body.min_stock || 0) }));
  handleForm($('#stockInForm'), '/api/stock-in', async () => { await Promise.all([loadProducts(), loadDashboard(), searchPrices($('#priceSearchInput').value.trim())]); }, body => ({ ...body, product_id: Number(body.product_id), quantity: Number(body.quantity), irr_unit_price: body.irr_unit_price === '' ? null : Number(body.irr_unit_price), supplier_id: body.supplier_id || null }));
  handleForm($('#saleForm'), '/api/sales', async () => { await Promise.all([loadProducts(), loadDashboard(), searchPrices($('#priceSearchInput').value.trim())]); }, body => ({ ...body, product_id: Number(body.product_id), quantity: Number(body.quantity), irr_unit_price: body.irr_unit_price === '' ? null : Number(body.irr_unit_price), technician_id: Number(body.technician_id) }));
  handleForm($('#directForm'), '/api/direct-use', async () => { await loadDashboard(); }, body => ({ ...body, quantity: Number(body.quantity), purchase_irr_unit_price: Number(body.purchase_irr_unit_price), use_irr_unit_price: body.use_irr_unit_price === '' ? null : Number(body.use_irr_unit_price), category_id: body.category_id || null, brand_id: body.brand_id || null, technician_id: Number(body.technician_id), supplier_id: Number(body.supplier_id) }));
  handleForm($('#technicianForm'), '/api/technicians', async () => { await loadReferences(); }, body => ({ ...body }));
  handleForm($('#supplierForm'), '/api/suppliers', async () => { await loadReferences(); }, body => ({ ...body }));
  handleForm($('#categoryForm'), '/api/categories', async () => { await loadReferences(); }, body => ({ ...body }));
  handleForm($('#brandForm'), '/api/brands', async () => { await loadReferences(); }, body => ({ ...body }));
  $('#reportFilterForm').addEventListener('submit', applyReportFilters);
  $('#clearReportFilters').addEventListener('click', () => { $('#reportKind').value = ''; $('#reportTechnician').value = ''; $('#reportBrand').value = ''; $('#reportCategory').value = ''; $('#reportSupplier').value = ''; initReportDates(); applyReportFilters(); });
  $('#printReportBtn').addEventListener('click', () => { if (!state.report) return toast('ابتدا گزارش را بسازید.', 'error'); window.print(); });
}
async function initializeData() {
  try {
    await loadReferences();
    await loadProducts();
    await searchPrices('');
    await loadDashboard();
    initReportDates();
    await applyReportFilters();
    updateTransactionPreviews();
  } catch (err) { toast(err.message, 'error'); }
}
async function boot() {
  initEvents();
  const session = await api('/api/session').catch(() => ({ authenticated: false }));
  if (session.authenticated) { showApp(session.username); await initializeData(); }
  else showLogin();
}

boot();
