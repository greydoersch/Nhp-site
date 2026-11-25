import {
  formatMoney, toCents, fromCents, linesFromDraft, lineTotalCents, computeTotals, roundQty,
} from "./pricing.js";

// ---------- storage ----------
const KEYS = { settings: "pe.settings", prices: "pe.prices", estimates: "pe.estimates", counter: "pe.counter" };

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    showBanner("Couldn't save on this device (storage full or blocked).", "error");
    return false;
  }
}

let settings = load(KEYS.settings, {
  accessCode: "", companyName: "Polar Excavation", companyPhone: "", companyEmail: "", companyAddress: "",
});
let priceSheet = load(KEYS.prices, null);
let defaultSheet = null;

async function loadDefaultSheet() {
  const res = await fetch("prices.json", { cache: "no-cache" });
  defaultSheet = await res.json();
  if (!priceSheet) priceSheet = structuredClone(defaultSheet);
}

const allEstimates = () => load(KEYS.estimates, []);
function saveEstimate(est) {
  est.updatedAt = new Date().toISOString();
  const list = allEstimates().filter((e) => e.id !== est.id);
  list.unshift(est);
  return save(KEYS.estimates, list);
}
function getEstimate(id) {
  return allEstimates().find((e) => e.id === id);
}
function nextQuoteNumber() {
  const n = load(KEYS.counter, 1000) + 1;
  save(KEYS.counter, n);
  return `Q-${n}`;
}

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showBanner(msg, kind = "info") {
  const b = $("#banner");
  b.textContent = msg;
  b.className = `banner ${kind}`;
  b.hidden = !msg;
}

function newEstimate() {
  return {
    id: crypto.randomUUID(),
    number: nextQuoteNumber(),
    createdAt: new Date().toISOString(),
    status: "draft",
    customer: { name: "", phone: "", email: "", address: "" },
    description: "",
    measurements: "",
    jobSummary: "",
    lines: [],
    assumptions: [],
    questions: [],
    risks: [],
    contingencyPct: priceSheet.settings?.contingencyPct ?? 0,
    taxPct: priceSheet.settings?.taxPct ?? 0,
    validDays: priceSheet.settings?.validDays ?? 30,
  };
}

// Resize photos on the phone before upload: smaller request, faster answer.
async function resizePhoto(file, maxEdge = 1568) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  return { media_type: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl };
}

// ---------- routing ----------
function route() {
  showBanner("");
  const [tab, id] = location.hash.replace(/^#/, "").split("/");
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === (tab || "new")));
  if (priceSheet?.placeholder && tab !== "prices") {
    showBanner("These are placeholder prices. Load your real price sheet on the Prices tab before sending any quote.");
  }
  switch (tab) {
    case "estimate": return renderEstimate(id);
    case "saved": return renderSaved();
    case "prices": return renderPrices();
    case "settings": return renderSettings();
    default: return renderNew();
  }
}
window.addEventListener("hashchange", route);

// ---------- New estimate ----------
let pendingPhotos = [];

function renderNew() {
  view.innerHTML = `
    <h1>New estimate</h1>
    <div class="card">
      <label for="cust">Customer <span class="hint">(optional now)</span></label>
      <input id="cust" placeholder="Name" autocomplete="off" />
      <label for="desc">Describe the job</label>
      <textarea id="desc" placeholder="e.g. New 3-bedroom septic in Wasilla. 1,250 gal tank about 15 ft from the house, two 60 ft leach trenches. Gravel driveway access, some birch to clear."></textarea>
      <label for="meas">Measurements <span class="hint">(anything you have: lengths, depths, areas)</span></label>
      <textarea id="meas" style="min-height:70px" placeholder="House to tank 15 ft. Trenches 2 x 60 ft, 3 ft wide, 4 ft deep."></textarea>
      <label for="photos">Site photos <span class="hint">(up to 6)</span></label>
      <input id="photos" type="file" accept="image/*" multiple />
      <div class="photos" id="photoList"></div>
    </div>
    <div class="actions">
      <button class="primary" id="draftBtn">Draft estimate with AI</button>
      <button id="blankBtn">Start blank</button>
    </div>
    <p class="hint">The AI picks items and quantities from your price sheet and shows its work. Prices come only from your sheet. Everything stays a draft until you approve it.</p>
  `;
  drawPhotos();

  $("#photos").addEventListener("change", async (e) => {
    const files = [...e.target.files].slice(0, 6 - pendingPhotos.length);
    for (const f of files) {
      try {
        pendingPhotos.push(await resizePhoto(f));
      } catch {
        showBanner(`Couldn't read ${f.name}.`, "error");
      }
    }
    e.target.value = "";
    drawPhotos();
  });

  $("#blankBtn").addEventListener("click", () => {
    const est = newEstimate();
    est.customer.name = $("#cust").value.trim();
    est.description = $("#desc").value.trim();
    est.measurements = $("#meas").value.trim();
    saveEstimate(est);
    pendingPhotos = [];
    location.hash = `#estimate/${est.id}`;
  });

  $("#draftBtn").addEventListener("click", draftWithAI);
}

function drawPhotos() {
  const list = $("#photoList");
  if (!list) return;
  list.innerHTML = pendingPhotos
    .map((p, i) => `<figure><img src="${p.preview}" alt="Site photo ${i + 1}" /><button data-i="${i}" aria-label="Remove photo">×</button></figure>`)
    .join("");
  list.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      pendingPhotos.splice(Number(b.dataset.i), 1);
      drawPhotos();
    }),
  );
}

async function draftWithAI() {
  const description = $("#desc").value.trim();
  const measurements = $("#meas").value.trim();
  if (!description && pendingPhotos.length === 0) {
    return showBanner("Describe the job or add a photo first.", "error");
  }
  if (!settings.accessCode) {
    return showBanner("Enter the access code on the Settings tab first.", "error");
  }

  const btn = $("#draftBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Drafting… (up to a minute)`;
  showBanner("");

  try {
    const res = await fetch("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": settings.accessCode },
      body: JSON.stringify({
        description,
        measurements,
        photos: pendingPhotos.map(({ media_type, data }) => ({ media_type, data })),
        priceSheet: { items: priceSheet.items.map(({ code, name, unit, category }) => ({ code, name, unit, category })) },
      }),
    });
    const out = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
    if (!res.ok) throw new Error(out.error || `Server error (${res.status}).`);

    const { lines, unknownCodes } = linesFromDraft(out.draft, priceSheet);
    const est = newEstimate();
    est.customer.name = $("#cust").value.trim();
    est.description = description;
    est.measurements = measurements;
    est.jobSummary = out.draft.job_summary;
    est.lines = lines;
    est.assumptions = out.draft.assumptions ?? [];
    est.questions = out.draft.questions_for_owner ?? [];
    est.risks = out.draft.site_risks ?? [];
    est.photoCount = pendingPhotos.length;
    if (unknownCodes.length) est.assumptions.push(`Dropped unknown item codes from the AI: ${unknownCodes.join(", ")}`);
    saveEstimate(est);
    pendingPhotos = [];
    location.hash = `#estimate/${est.id}`;
  } catch (err) {
    showBanner(err.message || "Couldn't reach the server. Check your signal and try again.", "error");
    btn.disabled = false;
    btn.textContent = "Draft estimate with AI";
  }
}

// ---------- Estimate editor ----------
function renderEstimate(id) {
  const est = getEstimate(id);
  if (!est) {
    view.innerHTML = `<p>Estimate not found. <a href="#saved">See saved estimates</a>.</p>`;
    return;
  }
  const locked = est.status === "approved";
  const totals = computeTotals(est.lines, est);
  const needsCheck = est.lines.some((l) => l.needsPriceCheck);

  view.innerHTML = `
    <h1>${esc(est.number)} <span class="status ${est.status}">${est.status === "approved" ? "APPROVED" : "DRAFT"}</span></h1>

    <div class="card">
      <h2>Customer</h2>
      <div class="row">
        <div><label for="c-name">Name</label><input id="c-name" value="${esc(est.customer.name)}" ${locked ? "disabled" : ""} /></div>
        <div><label for="c-phone">Phone</label><input id="c-phone" type="tel" value="${esc(est.customer.phone)}" ${locked ? "disabled" : ""} /></div>
      </div>
      <label for="c-email">Email</label><input id="c-email" type="email" value="${esc(est.customer.email)}" ${locked ? "disabled" : ""} />
      <label for="c-addr">Job address</label><input id="c-addr" value="${esc(est.customer.address)}" ${locked ? "disabled" : ""} />
      <label for="summary">Scope of work <span class="hint">(prints on the quote)</span></label>
      <textarea id="summary" style="min-height:70px" ${locked ? "disabled" : ""}>${esc(est.jobSummary)}</textarea>
    </div>

    <div class="card">
      <h2>Line items</h2>
      <div id="lines">
        ${est.lines.map((l, i) => lineHtml(l, i, locked)).join("") || `<p class="hint">No items yet.</p>`}
      </div>
      ${locked ? "" : `
        <label for="addItem">Add item from price sheet</label>
        <div style="display:flex;gap:8px">
          <select id="addItem">
            <option value="">Choose…</option>
            ${priceSheet.items.map((it) => `<option value="${esc(it.code)}">${esc(it.name)} (${esc(it.unit)})</option>`).join("")}
            <option value="CUSTOM">Custom item (not on sheet)</option>
          </select>
          <button id="addBtn">Add</button>
        </div>`}
    </div>

    <div class="card">
      <div class="totals">
        <span>Subtotal</span><span>${formatMoney(totals.subtotal)}</span>
        <span>Contingency <input id="cont" type="number" min="0" step="1" value="${est.contingencyPct}" ${locked ? "disabled" : ""} /> %</span><span>${formatMoney(totals.contingency)}</span>
        <span>Sales tax <input id="tax" type="number" min="0" step="0.1" value="${est.taxPct}" ${locked ? "disabled" : ""} /> %</span><span>${formatMoney(totals.tax)}</span>
        <span class="grand">Total</span><span class="grand">${formatMoney(totals.total)}</span>
      </div>
    </div>

    ${notesCard("Questions to settle before sending", est.questions)}
    ${notesCard("Site risks the AI noticed", est.risks)}
    ${notesCard("Assumptions", est.assumptions)}

    <div class="card">
      <h2>Your original notes</h2>
      <p style="white-space:pre-wrap;margin:0">${esc(est.description) || '<span class="hint">None</span>'}</p>
      ${est.measurements ? `<p style="white-space:pre-wrap"><b>Measurements:</b> ${esc(est.measurements)}</p>` : ""}
      ${est.photoCount ? `<p class="hint">${est.photoCount} photo(s) were used for the draft (not stored).</p>` : ""}
    </div>

    <div class="actions sticky">
      ${locked
        ? `<button id="unlockBtn">Back to draft</button>`
        : `<button class="primary" id="approveBtn">Approve prices</button>`}
      <button id="printBtn">Save as PDF</button>
      <button id="dupBtn">Duplicate</button>
      <button class="danger" id="delBtn">Delete</button>
    </div>
  `;

  if (needsCheck && !locked) showBanner("Highlighted items aren't on your price sheet. Set their price before approving.", "info");

  const persist = (rerender = false) => {
    saveEstimate(est);
    if (rerender) renderEstimate(id);
  };

  if (!locked) {
    const bind = (sel, fn) => $(sel).addEventListener("input", (e) => { fn(e.target.value); persist(); });
    bind("#c-name", (v) => (est.customer.name = v));
    bind("#c-phone", (v) => (est.customer.phone = v));
    bind("#c-email", (v) => (est.customer.email = v));
    bind("#c-addr", (v) => (est.customer.address = v));
    bind("#summary", (v) => (est.jobSummary = v));
    $("#cont").addEventListener("change", (e) => { est.contingencyPct = Math.max(0, Number(e.target.value) || 0); persist(true); });
    $("#tax").addEventListener("change", (e) => { est.taxPct = Math.max(0, Number(e.target.value) || 0); persist(true); });

    view.querySelectorAll("[data-field]").forEach((input) =>
      input.addEventListener("change", (e) => {
        const line = est.lines[Number(e.target.dataset.i)];
        const v = e.target.value;
        if (e.target.dataset.field === "qty") line.qty = roundQty(Math.max(0, Number(v) || 0));
        if (e.target.dataset.field === "price") { line.unitPriceCents = toCents(Math.max(0, Number(v) || 0)); line.needsPriceCheck = false; }
        if (e.target.dataset.field === "desc") line.description = v;
        persist(true);
      }),
    );
    view.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => { est.lines.splice(Number(b.dataset.remove), 1); persist(true); }),
    );
    $("#addBtn").addEventListener("click", () => {
      const code = $("#addItem").value;
      if (!code) return;
      if (code === "CUSTOM") {
        est.lines.push({ code: "CUSTOM", description: "Custom item", unit: "ea", qty: 1, unitPriceCents: 0, basis: "", needsPriceCheck: true });
      } else {
        const it = priceSheet.items.find((x) => x.code === code);
        est.lines.push({ code: it.code, description: it.name, unit: it.unit, qty: 1, unitPriceCents: toCents(it.price), basis: "Added by hand", needsPriceCheck: false });
      }
      persist(true);
    });
    $("#approveBtn").addEventListener("click", () => {
      if (est.lines.some((l) => l.needsPriceCheck)) return showBanner("Set a price on the highlighted items first.", "error");
      if (!est.lines.length) return showBanner("Add at least one item.", "error");
      if (priceSheet.placeholder && !confirm("You're still on placeholder prices. Approve anyway?")) return;
      est.status = "approved";
      est.approvedAt = new Date().toISOString();
      persist(true);
    });
  } else {
    $("#unlockBtn").addEventListener("click", () => { est.status = "draft"; delete est.approvedAt; persist(true); });
  }

  $("#printBtn").addEventListener("click", () => printQuote(est));
  $("#dupBtn").addEventListener("click", () => {
    const copy = { ...structuredClone(est), id: crypto.randomUUID(), number: nextQuoteNumber(), status: "draft", createdAt: new Date().toISOString() };
    delete copy.approvedAt;
    saveEstimate(copy);
    location.hash = `#estimate/${copy.id}`;
  });
  $("#delBtn").addEventListener("click", () => {
    if (!confirm(`Delete ${est.number}?`)) return;
    save(KEYS.estimates, allEstimates().filter((e) => e.id !== est.id));
    location.hash = "#saved";
  });
}

function lineHtml(l, i, locked) {
  const dis = locked ? "disabled" : "";
  return `
    <div class="line ${l.needsPriceCheck ? "check" : ""}">
      <div class="top">
        ${l.code === "CUSTOM" && !locked
          ? `<input data-field="desc" data-i="${i}" value="${esc(l.description)}" aria-label="Description" />`
          : `<span class="desc">${esc(l.description)}</span>`}
        <span class="code">${esc(l.code)}</span>
      </div>
      <div class="nums">
        <div><label for="q${i}">Qty (${esc(l.unit)})</label><input id="q${i}" type="number" inputmode="decimal" min="0" step="any" data-field="qty" data-i="${i}" value="${l.qty}" ${dis} /></div>
        <div><label for="p${i}">$ per ${esc(l.unit)}</label><input id="p${i}" type="number" inputmode="decimal" min="0" step="0.01" data-field="price" data-i="${i}" value="${fromCents(l.unitPriceCents).toFixed(2)}" ${dis} /></div>
        <div class="amt">${formatMoney(lineTotalCents(l))}</div>
      </div>
      ${l.basis ? `<div class="basis">${esc(l.basis)}</div>` : ""}
      ${l.needsPriceCheck ? `<div class="flag">Not on your price sheet: check the price.${l.unitPriceCents ? " AI's rough guess shown." : ""}</div>` : ""}
      ${locked ? "" : `<div style="text-align:right;margin-top:6px"><button class="small danger" data-remove="${i}">Remove</button></div>`}
    </div>`;
}

function notesCard(title, items) {
  if (!items?.length) return "";
  return `<div class="card"><h2>${esc(title)}</h2><ul class="notes">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
}

// ---------- Printed quote ----------
function printQuote(est) {
  const t = computeTotals(est.lines, est);
  const date = new Date(est.createdAt);
  const valid = new Date(date.getTime() + (est.validDays || 30) * 86400000);
  const fmtDate = (d) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const draft = est.status !== "approved";

  $("#print").innerHTML = `
    <div class="q-head">
      <div>
        <h1>${esc(settings.companyName || "Estimate")}</h1>
        <div class="q-small">${[settings.companyAddress, settings.companyPhone, settings.companyEmail].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      <div style="text-align:right">
        <div><b>Estimate ${esc(est.number)}</b></div>
        <div class="q-small">${fmtDate(date)}</div>
        ${draft ? `<div class="q-draft">DRAFT – NOT FOR CUSTOMER</div>` : ""}
      </div>
    </div>
    <p><b>Prepared for:</b> ${esc(est.customer.name) || "—"}<br/>
      ${est.customer.address ? `<b>Job site:</b> ${esc(est.customer.address)}<br/>` : ""}
      ${[est.customer.phone, est.customer.email].filter(Boolean).map(esc).join(" · ")}</p>
    ${est.jobSummary ? `<p><b>Scope of work:</b> ${esc(est.jobSummary)}</p>` : ""}
    <table class="q-table">
      <thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead>
      <tbody>
        ${est.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${l.qty} ${esc(l.unit)}</td><td class="n">${formatMoney(l.unitPriceCents)}</td><td class="n">${formatMoney(lineTotalCents(l))}</td></tr>`).join("")}
      </tbody>
    </table>
    <table class="q-totals">
      <tr><td>Subtotal</td><td class="n">${formatMoney(t.subtotal)}</td></tr>
      ${t.contingency ? `<tr><td>Contingency (${est.contingencyPct}%)</td><td class="n">${formatMoney(t.contingency)}</td></tr>` : ""}
      ${t.tax ? `<tr><td>Sales tax (${est.taxPct}%)</td><td class="n">${formatMoney(t.tax)}</td></tr>` : ""}
      <tr class="grand"><td>Total</td><td class="n">${formatMoney(t.total)}</td></tr>
    </table>
    <p class="q-small">This estimate is valid until ${fmtDate(valid)}. Quantities for excavation, rock and fill are estimated and may change with site conditions; changes will be discussed before extra work is done. Septic work is subject to permit approval and the required design sign-off.</p>
    <p class="q-small" style="margin-top:28px">Accepted by: ______________________________ &nbsp; Date: ______________</p>
  `;
  const prevTitle = document.title;
  document.title = `${est.number} ${est.customer.name || ""}`.trim();
  window.print();
  document.title = prevTitle;
}

// ---------- Saved ----------
function renderSaved() {
  const list = allEstimates();
  view.innerHTML = `
    <h1>Saved estimates</h1>
    ${list.length ? "" : `<p class="hint">Nothing saved yet. <a href="#new">Start one</a>.</p>`}
    ${list.map((e) => `
      <a class="card list-item" href="#estimate/${e.id}">
        <div>
          <div><b>${esc(e.number)}</b> ${esc(e.customer.name) || '<span class="hint">No name</span>'}</div>
          <div class="meta">${new Date(e.updatedAt || e.createdAt).toLocaleDateString()} · ${esc((e.jobSummary || e.description || "").slice(0, 70))}</div>
        </div>
        <div style="text-align:right">
          <div><b>${formatMoney(computeTotals(e.lines, e).total)}</b></div>
          <span class="status ${e.status}">${e.status === "approved" ? "APPROVED" : "DRAFT"}</span>
        </div>
      </a>`).join("")}
    <p class="hint">Estimates are saved on this phone only for now. Shared crew storage comes with the Supabase step.</p>
  `;
}

// ---------- Prices ----------
function renderPrices() {
  view.innerHTML = `
    <h1>Price sheet</h1>
    ${priceSheet.placeholder ? `<div class="banner info" style="margin:0 0 12px">Placeholder prices. Edit them here or import your sheet, then press "Mark as my real prices".</div>` : ""}
    <div class="card">
      <table class="prices">
        <thead><tr><th>Item</th><th class="unit">Unit</th><th class="price">Price $</th><th></th></tr></thead>
        <tbody>
          ${priceSheet.items.map((it, i) => `
            <tr>
              <td><input data-p="name" data-i="${i}" value="${esc(it.name)}" aria-label="Item name" /><div class="hint">${esc(it.code)} · ${esc(it.category || "")}</div></td>
              <td><input data-p="unit" data-i="${i}" value="${esc(it.unit)}" aria-label="Unit" /></td>
              <td><input data-p="price" data-i="${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${it.price}" aria-label="Price" /></td>
              <td><button class="small danger" data-del="${i}" aria-label="Remove item">×</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="actions"><button id="addPrice">Add item</button></div>
    </div>
    <div class="actions">
      ${priceSheet.placeholder ? `<button class="primary" id="markReal">Mark as my real prices</button>` : ""}
      <button id="exportPrices">Export</button>
      <label class="btn" style="margin:0">Import<input id="importPrices" type="file" accept="application/json" hidden /></label>
      <button class="danger" id="resetPrices">Reset to sample</button>
    </div>
    <p class="hint">Price changes apply to new estimates and items you add. Existing estimates keep their prices.</p>
  `;
  const persist = (rerender) => { save(KEYS.prices, priceSheet); if (rerender) renderPrices(); };

  view.querySelectorAll("[data-p]").forEach((inp) =>
    inp.addEventListener("change", (e) => {
      const it = priceSheet.items[Number(e.target.dataset.i)];
      const f = e.target.dataset.p;
      it[f] = f === "price" ? Math.max(0, Number(e.target.value) || 0) : e.target.value.trim();
      persist();
    }),
  );
  view.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      const it = priceSheet.items[Number(b.dataset.del)];
      if (!confirm(`Remove "${it.name}"?`)) return;
      priceSheet.items.splice(Number(b.dataset.del), 1);
      persist(true);
    }),
  );
  $("#addPrice").addEventListener("click", () => {
    const name = prompt("Item name?");
    if (!name) return;
    const unit = prompt("Unit (ea, hr, cy, lf, sf, day…)?", "ea") || "ea";
    let code = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) || "ITEM";
    while (priceSheet.items.some((x) => x.code === code)) code += "-2";
    priceSheet.items.push({ code, category: "Custom", name: name.trim(), unit: unit.trim(), price: 0 });
    persist(true);
  });
  $("#markReal")?.addEventListener("click", () => { priceSheet.placeholder = false; persist(true); route(); });
  $("#exportPrices").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(priceSheet, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "price-sheet.json" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#importPrices").addEventListener("change", async (e) => {
    try {
      const sheet = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(sheet.items) || !sheet.items.every((i) => i.code && i.name && i.unit && Number.isFinite(Number(i.price)))) {
        throw new Error();
      }
      priceSheet = sheet;
      persist(true);
    } catch {
      showBanner("That file isn't a valid price sheet.", "error");
    }
  });
  $("#resetPrices").addEventListener("click", () => {
    if (!confirm("Replace your price sheet with the sample prices?")) return;
    priceSheet = structuredClone(defaultSheet);
    persist(true);
  });
}

// ---------- Settings ----------
function renderSettings() {
  view.innerHTML = `
    <h1>Settings</h1>
    <div class="card">
      <label for="s-code">Access code <span class="hint">(from the owner; needed for AI drafts)</span></label>
      <input id="s-code" type="password" autocomplete="off" value="${esc(settings.accessCode)}" />
    </div>
    <div class="card">
      <h2>On the printed quote</h2>
      <label for="s-name">Company name</label><input id="s-name" value="${esc(settings.companyName)}" />
      <label for="s-addr">Address</label><input id="s-addr" value="${esc(settings.companyAddress)}" />
      <div class="row">
        <div><label for="s-phone">Phone</label><input id="s-phone" type="tel" value="${esc(settings.companyPhone)}" /></div>
        <div><label for="s-email">Email</label><input id="s-email" type="email" value="${esc(settings.companyEmail)}" /></div>
      </div>
    </div>
  `;
  const map = { "#s-code": "accessCode", "#s-name": "companyName", "#s-addr": "companyAddress", "#s-phone": "companyPhone", "#s-email": "companyEmail" };
  for (const [sel, key] of Object.entries(map)) {
    $(sel).addEventListener("input", (e) => { settings[key] = e.target.value.trim(); save(KEYS.settings, settings); });
  }
}

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
loadDefaultSheet()
  .then(route)
  .catch(() => {
    view.innerHTML = `<p>Couldn't load the price sheet. Check your connection and reload.</p>`;
  });
