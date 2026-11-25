import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatMoney, linesFromDraft, computeTotals, lineTotalCents } from "../estimator/pricing.js";

const sheet = JSON.parse(readFileSync(new URL("../estimator/prices.json", import.meta.url)));

test("formatMoney", () => {
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(123456789), "$1,234,567.89");
  assert.equal(formatMoney(-505), "-$5.05");
});

test("prices come from the sheet, not the AI", () => {
  const { lines, unknownCodes } = linesFromDraft({
    line_items: [
      { code: "TANK-1250", quantity: 1, quantity_basis: "3 bedroom", price: 1 },
      { code: "LEACH-TRENCH-LF", quantity: 120, quantity_basis: "2 x 60 ft" },
      { code: "MADE-UP", quantity: 5, quantity_basis: "" },
      { code: "MOB", quantity: 0, quantity_basis: "zero qty dropped" },
    ],
    custom_items: [],
  }, sheet);
  assert.deepEqual(unknownCodes, ["MADE-UP"]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].unitPriceCents, 395000);
  assert.equal(lineTotalCents(lines[1]), 120 * 4800);
});

test("custom items are flagged for a price check", () => {
  const { lines } = linesFromDraft({
    line_items: [],
    custom_items: [{ description: "Culvert", unit: "ea", quantity: 1, suggested_unit_price: 600, reason: "driveway crossing" }],
  }, sheet);
  assert.equal(lines[0].needsPriceCheck, true);
  assert.equal(lines[0].unitPriceCents, 60000);
});

test("totals: contingency then tax, in cents", () => {
  const lines = [
    { qty: 1, unitPriceCents: 100000 },
    { qty: 2.5, unitPriceCents: 3333 },
  ];
  const t = computeTotals(lines, { contingencyPct: 10, taxPct: 3 });
  assert.equal(t.subtotal, 108333);
  assert.equal(t.contingency, 10833);
  assert.equal(t.tax, 3575);
  assert.equal(t.total, 108333 + 10833 + 3575);
});

test("price sheet codes are unique and prices valid", () => {
  const codes = sheet.items.map((i) => i.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const i of sheet.items) assert.ok(Number.isFinite(i.price) && i.price >= 0, i.code);
});
