// Pricing engine shared by the app and the tests.
// The AI only ever proposes WHAT to charge for and HOW MUCH (quantities).
// Every dollar amount is computed here from the price sheet, in whole cents,
// so the math is the same every time and never comes from the model.

export const toCents = (dollars) => Math.round(Number(dollars) * 100);
export const fromCents = (cents) => cents / 100;

export function formatMoney(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export function indexPriceSheet(sheet) {
  const map = new Map();
  for (const item of sheet.items) map.set(item.code, item);
  return map;
}

// Turn the AI's draft (codes + quantities) into estimate lines priced from the sheet.
// Codes that aren't on the sheet are dropped and reported, never invented.
export function linesFromDraft(draft, sheet) {
  const index = indexPriceSheet(sheet);
  const lines = [];
  const unknownCodes = [];

  for (const li of draft.line_items ?? []) {
    const item = index.get(li.code);
    if (!item) {
      unknownCodes.push(li.code);
      continue;
    }
    const qty = Number(li.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    lines.push({
      code: item.code,
      description: item.name,
      unit: item.unit,
      qty: roundQty(Math.max(qty, item.min_qty ?? 0)),
      unitPriceCents: toCents(item.price),
      basis: li.quantity_basis ?? "",
      needsPriceCheck: false,
    });
  }

  for (const ci of draft.custom_items ?? []) {
    const qty = Number(ci.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    lines.push({
      code: "CUSTOM",
      description: ci.description,
      unit: ci.unit,
      qty: roundQty(qty),
      unitPriceCents: toCents(ci.suggested_unit_price ?? 0),
      basis: ci.reason ?? "",
      needsPriceCheck: true, // not on your sheet: owner must set the price
    });
  }

  return { lines, unknownCodes };
}

export function roundQty(q) {
  return Math.round(q * 100) / 100;
}

export function lineTotalCents(line) {
  return Math.round(line.qty * line.unitPriceCents);
}

// settings: { contingencyPct, taxPct } as plain percents (e.g. 10 = 10%)
export function computeTotals(lines, settings = {}) {
  const subtotal = lines.reduce((s, l) => s + lineTotalCents(l), 0);
  const contingency = Math.round(subtotal * (Number(settings.contingencyPct) || 0) / 100);
  const taxable = subtotal + contingency;
  const tax = Math.round(taxable * (Number(settings.taxPct) || 0) / 100);
  return { subtotal, contingency, tax, total: taxable + tax };
}
