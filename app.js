'use strict';

// ══════════════════════════════════════════════════════════
//  AUSTRALIAN TAX ENGINE  (FY 2025-26)
//  All projection maths runs in today's dollars — brackets,
//  caps and thresholds are assumed to keep pace with inflation.
// ══════════════════════════════════════════════════════════

function incomeTax(income) {
  if (income <= 18200)  return 0;
  if (income <= 45000)  return (income - 18200) * 0.16;
  if (income <= 135000) return 4288 + (income - 45000) * 0.30;
  if (income <= 190000) return 31288 + (income - 135000) * 0.37;
  return 51638 + (income - 190000) * 0.45;
}

const MEDICARE_THRESHOLD = 28011; // single low-income threshold
function medicareLevy(income) {
  if (income <= MEDICARE_THRESHOLD) return 0;
  return Math.min(income * 0.02, (income - MEDICARE_THRESHOLD) * 0.10);
}

// Medicare Levy Surcharge — applies without private hospital cover
const MLS_SINGLE = [101000, 118000, 158000];
const MLS_FAMILY = [202000, 236000, 316000];
function mlsAmount(mlsIncome, combinedIncome, family) {
  const t = family ? MLS_FAMILY : MLS_SINGLE;
  const test = family ? combinedIncome : mlsIncome;
  const rate = test > t[2] ? 0.015 : test > t[1] ? 0.0125 : test > t[0] ? 0.01 : 0;
  return mlsIncome * rate;
}

function lito(income) {
  if (income <= 37500) return 700;
  if (income <= 45000) return 700 - (income - 37500) * 0.05;
  if (income <= 66667) return 325 - (income - 45000) * 0.015;
  return 0;
}

// HELP repayments — 2025-26 marginal system
function hecsRepayment(repayIncome) {
  if (repayIncome <= 67000)  return 0;
  if (repayIncome <= 125000) return (repayIncome - 67000) * 0.15;
  return 8700 + (repayIncome - 125000) * 0.17;
}

function div293Tax(taxableIncome, concessional) {
  const combined = taxableIncome + concessional;
  if (combined <= 250000) return 0;
  return Math.min(combined - 250000, concessional) * 0.15;
}

// Marginal cost of extra assessable income (e.g. investment distributions)
// stacked on top of a person's existing taxable income
const taxPlusMedicare  = t => Math.max(0, incomeTax(t) - lito(t)) + medicareLevy(t);
const taxOnExtraIncome = (base, extra) =>
  extra <= 0 ? 0 : taxPlusMedicare(base + extra) - taxPlusMedicare(base);

function calcTax(grossSalary, salarySacrifice, hasHECS, opts = {}) {
  const taxable   = Math.max(0, grossSalary - salarySacrifice);
  const mlsIncome = taxable + salarySacrifice; // income for MLS/HELP incl. reportable super
  const base      = Math.max(0, incomeTax(taxable) - lito(taxable)); // LITO offsets income tax only
  const medicare  = medicareLevy(taxable);
  const mls       = opts.noPHI ? mlsAmount(mlsIncome, opts.mlsCombined ?? mlsIncome, !!opts.family) : 0;
  const raw       = base + medicare + mls;
  // HELP repayment income includes reportable super — sacrifice doesn't reduce it
  const hecs      = hasHECS ? hecsRepayment(mlsIncome) : 0;
  const total     = raw + hecs;
  return { taxable, raw, medicare, mls, hecs, total, net: Math.max(0, grossSalary - salarySacrifice - total) };
}

// ══════════════════════════════════════════════════════════
//  SUPERANNUATION & AGE PENSION
// ══════════════════════════════════════════════════════════

const CONCESSIONAL_CAP      = 30000;
const NON_CONCESSIONAL_CAP  = 120000;
const PRESERVATION_AGE      = 60;
const UNRESTRICTED_AGE      = 65;
const AGE_PENSION_AGE       = 67;
const TRANSFER_BALANCE_CAP  = 2000000;

function minDrawdownRate(age) {
  if (age < 65) return 0.040;
  if (age < 75) return 0.050;
  if (age < 80) return 0.060;
  if (age < 85) return 0.070;
  if (age < 90) return 0.090;
  if (age < 95) return 0.110;
  return 0.140;
}

const PENSION_SINGLE = 29887;
const PENSION_COUPLE = 45104;
const DEEM_LOW = 0.0075, DEEM_HIGH = 0.0275; // deeming rates from 1 Jul 2025
const DEEM_THRESH_SINGLE = 64200, DEEM_THRESH_COUPLE = 106200;
const INCOME_FREE_SINGLE = 218 * 26, INCOME_FREE_COUPLE = 380 * 26;
const WORK_BONUS = 7800; // employment income disregarded by the income test ($300/fn)

// Pension paid is the LOWER of the assets-test and income-test results.
// For a couple with only one member of pension age, roughly the member
// rate (half the couple rate) is payable, tested on combined means.
function agePensionEstimate(assessableAssets, homeowner, couple, opts = {}) {
  const bothEligible = opts.bothEligible !== false;
  const maxRate = couple ? (bothEligible ? PENSION_COUPLE : PENSION_COUPLE / 2) : PENSION_SINGLE;
  const fullThresh = (couple ? 481500 : 321500) + (homeowner ? 0 : 258000);
  const assetTest = Math.max(0, maxRate -
    Math.max(0, Math.floor((assessableAssets - fullThresh) / 1000)) * 3 * 26);
  const dt = couple ? DEEM_THRESH_COUPLE : DEEM_THRESH_SINGLE;
  const deemed = Math.min(assessableAssets, dt) * DEEM_LOW +
    Math.max(0, assessableAssets - dt) * DEEM_HIGH;
  const employment = Math.max(0, (opts.otherIncome || 0) - WORK_BONUS);
  const freeArea = couple ? INCOME_FREE_COUPLE : INCOME_FREE_SINGLE;
  const incomeTest = Math.max(0, maxRate - Math.max(0, deemed + employment - freeArea) * 0.5);
  return Math.min(assetTest, incomeTest);
}

// ══════════════════════════════════════════════════════════
//  FIRE CALCULATIONS
// ══════════════════════════════════════════════════════════

const fiNumber    = (expenses, swr) => expenses / swr;
const coastTarget = (fi, years, r)  => fi / Math.pow(1 + r, years);
const annuityPV   = (pmt, years, r) => years <= 0 ? 0
  : Math.abs(r) < 1e-5 ? pmt * years : pmt * (1 - Math.pow(1 + r, -years)) / r;

function earlyFIBridge(realExpenses, superNowReal, yearsToPreserve, realInvR, realSupR, swr) {
  const N = yearsToPreserve;
  if (N <= 0) return realExpenses / swr;
  const bridge = annuityPV(realExpenses, N, realInvR);
  const superAtPreserve = superNowReal * Math.pow(1 + realSupR, N);
  const fi60    = realExpenses / swr;
  const deficit = Math.max(0, fi60 - superAtPreserve) / Math.pow(1 + realInvR, N);
  return bridge + deficit;
}

// Annual P&I repayment on a nominal mortgage (standard annuity formula).
// Returns 0 if amount or term is zero.
function annualMortgageRepayment(principal, annualRate, termYears) {
  if (principal <= 0 || termYears <= 0) return 0;
  if (annualRate <= 0) return principal / termYears;
  const r = annualRate / 12;
  const n = termYears * 12;
  const monthly = principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  return monthly * 12;
}

// Effective full expenses at a given age, adjusted for house purchase/mortgage/payoff.
// Returns the adjusted fullExpenses (rent removed, mortgage substituted where applicable).
function houseExpAdjAt(inp, age) {
  const { houseDeposit = 0, houseBuyAge = 0, mortgageAmount = 0, rentSaving = 0,
          mortgageRate = 0, mortgageTerm = 0, fullExpenses } = inp;
  const active = houseDeposit > 0 || mortgageAmount > 0;
  if (!active || age < houseBuyAge) return fullExpenses;
  const repayment = annualMortgageRepayment(mortgageAmount, mortgageRate, mortgageTerm);
  const paidAge   = mortgageTerm > 0 ? houseBuyAge + mortgageTerm : null;
  const adj = (paidAge == null || age < paidAge) ? (repayment - rentSaving) : -rentSaving;
  return Math.max(0, fullExpenses + adj);
}

// ══════════════════════════════════════════════════════════
//  YEAR-BY-YEAR PROJECTION ENGINE (today's dollars)
// ══════════════════════════════════════════════════════════

function project(inp, opts = {}) {
  const {
    currentAge, retirementAge, grossSalary, partnerSalary,
    sgRate, extraConcessional, extraNonConcessional, partnerExtraConcessional = 0,
    currentExpenses, leanExpenses, baristaExpenses, baristaIncome, baristaStopAge, fullExpenses,
    superBalance, partnerSuperBalance, investBalance, cashBalance,
    partnerInvestBalance = 0, partnerCashBalance = 0,
    investReturn, superReturn, cashReturn, inflation, swr,
    taxableShare = 0.5, investHolder = 'lower', contribTarget = 'mine',
    includeAgePension, homeowner, couple, growSalary,
    hecsActive = false, hecsBalance = 0,
    partnerHecsActive = false, partnerHecsBalance = 0,
    privateHealth = true, partnerAge = 0, partnerRetirementAge = 0,
    carryForwardCap = 0, partnerCarryForwardCap = 0,
    slowGoAge = 75, slowGoPct = 0,
    windfallAmount = 0, windfallAge = 0, oneOffAmount = 0, oneOffAge = 0,
    houseDeposit = 0, houseBuyAge = 0, mortgageAmount = 0, rentSaving = 0,
    mortgageRate = 0, mortgageTerm = 0,
  } = inp;

  // Pre-compute mortgage annual repayment (nominal dollars; inputs are in today's $
  // so we treat it as a real cost — like all other expense figures in this engine)
  const mortgageRepayment = annualMortgageRepayment(mortgageAmount, mortgageRate, mortgageTerm);
  const houseBuyActive    = houseDeposit > 0 || mortgageAmount > 0;
  const mortgagePaidAge   = houseBuyActive && mortgageTerm > 0 ? houseBuyAge + mortgageTerm : null;

  const light = !!opts.light;          // Monte Carlo mode: skip rows/milestones
  const vol   = opts.vol || 0;
  const shock = opts.shock || null;

  const realR     = (1 + investReturn) / (1 + inflation) - 1;
  const realSupR  = (1 + superReturn) / (1 + inflation) - 1;
  const realSupPenR = (1 + superReturn + 0.01) / (1 + inflation) - 1; // ~1.0% boost in tax-free pension phase
  const realCashR = (1 + cashReturn) / (1 + inflation) - 1;

  // Per-person super pools: preservation age, pension means tests and
  // minimum drawdowns all depend on the owner's age, not the household's
  let sup1 = superBalance, sup2 = partnerSuperBalance;
  let inv  = investBalance + partnerInvestBalance;
  let cash = cashBalance + partnerCashBalance;
  let p1Tapped = false, p2Tapped = false; // super converted to pension phase

  // HELP indexes ≈ CPI, so the real balance only falls via repayments
  let p1Help = hecsActive ? hecsBalance : 0;
  let p2Help = couple && partnerHecsActive ? partnerHecsBalance : 0;
  let helpPaidOffAge = null;
  
  let p1CarryFwd = carryForwardCap;
  let p2CarryFwd = partnerCarryForwardCap;

  // Investment & cash income is taxed at the marginal rate of whichever
  // partner holds the assets (couples typically use the lower earner)
  const investmentTax = (assessable, p1Income, p2Income, age, p2AgeNow) => {
    if (assessable <= 0) return 0;
    const p1Sen = age >= AGE_PENSION_AGE;
    const p2Sen = couple && p2AgeNow >= AGE_PENSION_AGE;
    if (!couple) return taxOnExtraIncome(p1Income, assessable, p1Sen);
    if (investHolder === 'higher') return taxOnExtraIncome(Math.max(p1Income, p2Income), assessable, p1Income >= p2Income ? p1Sen : p2Sen);
    if (investHolder === 'split')
      return taxOnExtraIncome(p1Income, assessable / 2, p1Sen) + taxOnExtraIncome(p2Income, assessable / 2, p2Sen);
    return taxOnExtraIncome(Math.min(p1Income, p2Income), assessable, p1Income <= p2Income ? p1Sen : p2Sen);
  };

  const fi     = fiNumber(fullExpenses, swr);
  const leanFI = fiNumber(leanExpenses, swr);

  const rows = [], totalsReal = [];
  let leanAge = null, coastAge = null, baristaAge = null, fullAge = null;
  let depleteAge = null, failed = false;

  for (let age = currentAge; age <= 90; age++) {
    const yr       = age - currentAge;
    const infAdj   = Math.pow(1 + inflation, yr);
    const retired  = age >= retirementAge;

    const z    = shock ? shock(yr) : 0;
    const rInv = realR    + vol * z;
    const rSup = realSupR + vol * z;
    const rSupPen = realSupPenR + vol * z;

    const p2AgeNow  = couple ? partnerAge + yr : 0;
    const p2Working = couple && partnerSalary > 0 && p2AgeNow < partnerRetirementAge;
    // Each person's super unlocks at their own preservation age
    const p1Can = age >= UNRESTRICTED_AGE || (age >= PRESERVATION_AGE && retired);
    const p2Can = couple && (p2AgeNow >= UNRESTRICTED_AGE ||
      (p2AgeNow >= PRESERVATION_AGE && !p2Working));

    const growSuper = (bal, tapped) => {
      if (!tapped) return bal * (1 + rSup);
      const penBal = Math.min(bal, TRANSFER_BALANCE_CAP);
      const accBal = Math.max(0, bal - penBal);
      return penBal * (1 + rSupPen) + accBal * (1 + rSup);
    };

    // One-off life events, entered in today's dollars
    if (windfallAmount > 0 && age === windfallAge) inv += windfallAmount;
    if (oneOffAmount > 0 && age === oneOffAge) {
      let ev = oneOffAmount;
      const c = Math.min(ev, cash); cash -= c; ev -= c;
      const i = Math.min(ev, inv);  inv  -= i; ev -= i;
      if (ev > 0 && p1Can) { const s = Math.min(ev, sup1); sup1 -= s; ev -= s; if (s > 0) p1Tapped = true; }
      if (ev > 0 && p2Can) { const s = Math.min(ev, sup2); sup2 -= s; ev -= s; if (s > 0) p2Tapped = true; }
      if (ev > 1 && !failed) { failed = true; depleteAge = age; }
    }
    // House purchase: draw deposit from portfolio at buy age
    if (houseBuyActive && age === houseBuyAge && houseDeposit > 0) {
      let dep = houseDeposit;
      const c = Math.min(dep, cash); cash -= c; dep -= c;
      const i = Math.min(dep, inv);  inv  -= i; dep -= i;
      if (dep > 0 && p1Can) { const s = Math.min(dep, sup1); sup1 -= s; dep -= s; if (s > 0) p1Tapped = true; }
      if (dep > 0 && p2Can) { const s = Math.min(dep, sup2); sup2 -= s; dep -= s; if (s > 0) p2Tapped = true; }
      if (dep > 1 && !failed) { failed = true; depleteAge = age; }
    }

    // Expense adjustment for house purchase phase:
    //   pre-buy:       base expenses (includes rent)
    //   buying→payoff: replace rent with mortgage repayment
    //   post-payoff:   remove rent, no mortgage
    const houseExpAdj = !houseBuyActive || age < houseBuyAge ? 0
      : (mortgagePaidAge == null || age < mortgagePaidAge) ? (mortgageRepayment - rentSaving)
      : -rentSaving;
    // Whether we own the home yet (affects Age Pension assets test homeowner threshold)
    const isHomeowner = homeowner || (houseBuyActive && age >= houseBuyAge);

    let annualTax = {}, annualSavings = 0, sgContrib = 0, extraConc = 0,
        netSuperContrib = 0, pensionY = 0, supDraw = 0, invDraw = 0,
        cashDraw = 0, householdNet = 0, invTax = 0;

    if (!retired) {
      // Australian taxation is individual — each earner taxed separately.
      // Flat real salary if it tracks inflation, otherwise declining in real terms.
      const p1Salary = growSalary ? grossSalary : grossSalary / infAdj;
      const p2Salary = p2Working ? (growSalary ? partnerSalary : partnerSalary / infAdj) : 0;

      const p1SG  = p1Salary * sgRate;
      const p2SG  = p2Salary * sgRate;
      
      const p1BaseCap = Math.max(0, CONCESSIONAL_CAP - p1SG);
      const p1Sac = Math.min(extraConcessional, p1BaseCap + p1CarryFwd);
      if (p1Sac > p1BaseCap) p1CarryFwd = Math.max(0, p1CarryFwd - (p1Sac - p1BaseCap));
      
      const p2BaseCap = Math.max(0, CONCESSIONAL_CAP - p2SG);
      const p2Sac = p2Working ? Math.min(partnerExtraConcessional, p2BaseCap + p2CarryFwd) : 0;
      if (p2Working && p2Sac > p2BaseCap) p2CarryFwd = Math.max(0, p2CarryFwd - (p2Sac - p2BaseCap));

      const nonConc = Math.min(extraNonConcessional, NON_CONCESSIONAL_CAP);

      const mlsOpts = { noPHI: !privateHealth, family: couple, mlsCombined: p1Salary + p2Salary };
      const p1Tax = calcTax(p1Salary, p1Sac, p1Help > 0, { ...mlsOpts, isSenior: age >= AGE_PENSION_AGE });
      const p2Tax = p2Salary > 0 ? calcTax(p2Salary, p2Sac, p2Help > 0, { ...mlsOpts, isSenior: p2AgeNow >= AGE_PENSION_AGE })
        : { net: 0, raw: 0, hecs: 0, total: 0, taxable: 0 };

      // HELP: repay only until the balance is gone, then keep the cash
      const p1Repay = Math.min(p1Tax.hecs, p1Help);
      const p2Repay = Math.min(p2Tax.hecs, p2Help);
      p1Help -= p1Repay; p2Help -= p2Repay;
      if (hecsActive && helpPaidOffAge == null && p1Help <= 0) helpPaidOffAge = age;

      const takeHome = p1Tax.net + (p1Tax.hecs - p1Repay) + p2Tax.net + (p2Tax.hecs - p2Repay);
      householdNet = takeHome;

      const cashflow = takeHome - (currentExpenses + houseExpAdj) - nonConc;
      if (cashflow >= 0) {
        annualSavings = cashflow;
      } else {
        let deficit = -cashflow;
        const c = Math.min(deficit, cash); cash -= c; deficit -= c; cashDraw = c;
        const i = Math.min(deficit, inv);  inv  -= i; deficit -= i; invDraw = i;
        if (deficit > 0 && p2Can && sup2 > 0) {
          const s = Math.min(deficit, sup2); sup2 -= s; deficit -= s; supDraw += s; p2Tapped = true;
        }
        if (deficit > 0 && p1Can && sup1 > 0) {
          const s = Math.min(deficit, sup1); sup1 -= s; deficit -= s; supDraw += s; p1Tapped = true;
        }
        if (deficit > 1 && !failed) { failed = true; depleteAge = age; }
      }

      const p1Conc = p1SG + p1Sac, p2Conc = p2SG + p2Sac;
      const p1SuperTax = p1Conc * 0.15 + div293Tax(p1Tax.taxable, p1Conc);
      const p2SuperTax = p2Conc * 0.15 + div293Tax(p2Tax.taxable, p2Conc);
      const p1ConcNet  = p1Conc - p1SuperTax;
      const p2ConcNet  = p2Conc - p2SuperTax;
      netSuperContrib  = p1ConcNet + p2ConcNet + nonConc;

      // Employer SG must stay with the earner; your extra contributions can
      // be routed (contribution splitting / spouse contributions)
      const p1SGNet    = p1Conc > 0 ? p1ConcNet * (p1SG / p1Conc) : 0;
      const p1ExtraNet = (p1ConcNet - p1SGNet) + nonConc;
      let toSup1 = p1SGNet, toSup2 = p2ConcNet;
      if (couple && contribTarget === 'partner')    toSup2 += p1ExtraNet;
      else if (couple && contribTarget === 'split') { toSup1 += p1ExtraNet / 2; toSup2 += p1ExtraNet / 2; }
      else                                          toSup1 += p1ExtraNet;

      // Investment distributions + cash interest, taxed at the holder's rate.
      // Balances are in real dollars grown at real rates, so use real returns here.
      const assessable = inv * rInv * taxableShare + cash * realCashR;
      invTax = investmentTax(assessable, p1Tax.taxable, p2Tax.taxable, age, p2AgeNow);

      annualTax = {
        taxable: p1Tax.taxable + p2Tax.taxable,
        raw:   p1Tax.raw + p2Tax.raw,
        hecs:  p1Repay + p2Repay,
        total: p1Tax.raw + p2Tax.raw + p1Repay + p2Repay,
        net:   takeHome,
        p1Net: p1Tax.net + (p1Tax.hecs - p1Repay), p1Raw: p1Tax.raw, p1Hecs: p1Repay,
      };
      sgContrib = p1SG + p2SG;
      extraConc = p1Sac;

      sup1 = growSuper(Math.max(0, sup1 + toSup1), p1Tapped);
      sup2 = growSuper(Math.max(0, sup2 + toSup2), p2Tapped);
      inv  = Math.max(0, inv + annualSavings) * (1 + rInv);
      cash = Math.max(0, cash) * (1 + realCashR);

    } else {
      // Full retirement path — no part-time income assumed here.
      // Later-life spending reduction (go-go / slow-go)
      const expReal = (fullExpenses + houseExpAdj) * (slowGoPct > 0 && age >= slowGoAge ? 1 - slowGoPct : 1);

      // Partner may still be working after the primary retires
      let p2ToSup1 = 0, p2ToSup2 = 0;
      let p2Net = 0, p2SalaryNow = 0, p2TaxableNow = 0;
      if (p2Working) {
        p2SalaryNow = growSalary ? partnerSalary : partnerSalary / infAdj;
        const p2SG  = p2SalaryNow * sgRate;
        const p2BaseCap = Math.max(0, CONCESSIONAL_CAP - p2SG);
        const p2Sac = Math.min(partnerExtraConcessional, p2BaseCap + p2CarryFwd);
        if (p2Sac > p2BaseCap) p2CarryFwd = Math.max(0, p2CarryFwd - (p2Sac - p2BaseCap));
        const p2Tax = calcTax(p2SalaryNow, p2Sac, p2Help > 0,
          { noPHI: !privateHealth, family: couple, mlsCombined: p2SalaryNow, isSenior: p2AgeNow >= AGE_PENSION_AGE });
        const p2Repay = Math.min(p2Tax.hecs, p2Help);
        p2Help -= p2Repay;
        p2Net = p2Tax.net + (p2Tax.hecs - p2Repay);
        p2TaxableNow = p2Tax.taxable;
        const p2Conc = p2SG + p2Sac;
        const p2SuperTax = p2Conc * 0.15 + div293Tax(p2Tax.taxable, p2Conc);
        const p2ConcNet = p2Conc - p2SuperTax;
        netSuperContrib = p2ConcNet;
        sgContrib = p2SG;
        extraConc = p2Sac;
        
        const p2SGNet    = p2Conc > 0 ? p2ConcNet * (p2SG / p2Conc) : 0;
        const p2ExtraNet = p2ConcNet - p2SGNet;
        p2ToSup2 = p2SGNet;
        if (couple && contribTarget === 'mine')       p2ToSup1 += p2ExtraNet;
        else if (couple && contribTarget === 'split') { p2ToSup1 += p2ExtraNet / 2; p2ToSup2 += p2ExtraNet / 2; }
        else                                          p2ToSup2 += p2ExtraNet;

        annualTax = {
          taxable: p2Tax.taxable,
          raw: p2Tax.raw,
          hecs: p2Repay,
          total: p2Tax.raw + p2Repay,
          net: p2Net,
          p1Net: 0, p1Raw: 0, p1Hecs: 0,
        };
      } else {
        annualTax = { taxable: 0, raw: 0, hecs: 0, total: 0, net: 0, p1Net: 0, p1Raw: 0, p1Hecs: 0 };
      }
      householdNet = p2Net;

      // Age Pension: per-person eligibility; an under-pension-age partner's
      // untapped accumulation super is exempt from both means tests
      const p1Eligible = age >= AGE_PENSION_AGE;
      const p2Eligible = couple && p2AgeNow >= AGE_PENSION_AGE;
      if (includeAgePension && (p1Eligible || p2Eligible)) {
        const assessable = inv + cash
          + ((p1Eligible || p1Tapped) ? sup1 : 0)
          + ((p2Eligible || p2Tapped) ? sup2 : 0);
        pensionY = agePensionEstimate(assessable, isHomeowner, couple, {
          bothEligible: couple ? (p1Eligible && p2Eligible) : true,
          otherIncome: p2SalaryNow,
        });
      }

      let needed = expReal - p2Net - pensionY;
      if (needed < 0) { annualSavings = -needed; inv += -needed; needed = 0; } // surplus income reinvested

      // Draw from pension-phase super, oldest owner first — leaving the
      // younger partner's super in accumulation (growing and pension-exempt)
      let excessToInv = 0;
      const pots = [];
      if (p1Can && sup1 > 0) pots.push({ who: 1, ownerAge: age });
      if (p2Can && sup2 > 0) pots.push({ who: 2, ownerAge: p2AgeNow });
      pots.sort((a, b) => b.ownerAge - a.ownerAge);
      for (const pot of pots) {
        const bal    = pot.who === 1 ? sup1 : sup2;
        const tapped = pot.who === 1 ? p1Tapped : p2Tapped;
        if (!tapped && needed <= 0) continue; // stays in accumulation
        const floorDraw = tapped ? bal * minDrawdownRate(pot.ownerAge) : 0;
        const draw  = Math.min(bal, Math.max(floorDraw, Math.min(Math.max(0, needed), bal)));
        const spent = Math.min(draw, Math.max(0, needed));
        needed -= spent;
        excessToInv += draw - spent; // forced minimum drawdown above need is reinvested
        supDraw += draw;
        if (pot.who === 1) { sup1 -= draw; p1Tapped = true; }
        else               { sup2 -= draw; p2Tapped = true; }
      }
      if (needed > 0) { invDraw  = Math.min(needed, inv);  needed -= invDraw; }
      if (needed > 0) { cashDraw = Math.min(needed, cash); needed -= cashDraw; }
      if (needed > 1 && !failed) { failed = true; depleteAge = age; }

      // Investment income still taxed — at the holder's (now low) rate.
      // Balances are in real dollars, so use real returns.
      const assessable = inv * rInv * taxableShare + cash * realCashR;
      invTax = investmentTax(assessable, 0, p2TaxableNow, age, p2AgeNow);

      sup1 = growSuper(Math.max(0, sup1 + p2ToSup1), p1Tapped);
      sup2 = growSuper(Math.max(0, sup2 + p2ToSup2), p2Tapped);
      inv  = Math.max(0, inv - invDraw + excessToInv) * (1 + rInv);
      cash = Math.max(0, cash - cashDraw)             * (1 + realCashR);
    }

    // Settle this year's tax on investment/cash income
    if (invTax > 0) {
      const fromInv = Math.min(invTax, inv);
      inv -= fromInv;
      cash = Math.max(0, cash - (invTax - fromInv));
    }

    const total = sup1 + sup2 + inv + cash;
    totalsReal.push(total);

    if (!light) {
      const accessible = (p1Can ? sup1 : 0) + (p2AgeNow >= PRESERVATION_AGE ? sup2 : 0) + inv + cash;

      const supAll = sup1 + sup2;
      const yToPreserv = Math.max(0, PRESERVATION_AGE - age);
      // Effective expenses at this age: once house is bought, rent is gone;
      // during mortgage, repayment replaces rent; after payoff, just no rent.
      const effFull    = Math.max(0, fullExpenses    + houseExpAdj);
      const effLean    = Math.max(0, leanExpenses    + houseExpAdj);
      const effBarista = Math.max(0, baristaExpenses + houseExpAdj);
      const leanTgt = age >= PRESERVATION_AGE ? fiNumber(effLean, swr)
        : earlyFIBridge(effLean, supAll, yToPreserv, realR, realSupR, swr);
      // Barista target: fund full barista expenses, offset by the PV of
      // part-time income earned from now until baristaStopAge
      const bIncPV  = annuityPV(baristaIncome, Math.max(0, baristaStopAge - age), realR);
      const bBase   = age >= PRESERVATION_AGE ? fiNumber(effBarista, swr)
        : earlyFIBridge(effBarista, supAll, yToPreserv, realR, realSupR, swr);
      const baristaTgt = Math.max(0, bBase - bIncPV);
      const fullTgt = age >= PRESERVATION_AGE ? fiNumber(effFull, swr)
        : earlyFIBridge(effFull, supAll, yToPreserv, realR, realSupR, swr);
      const checkW = age >= PRESERVATION_AGE ? total : accessible;

      // Coast target: full FIRE number discounted back to now. Pre-60, only
      // liquid assets can fund the bridge to preservation age — super is
      // locked and must be checked via earlyFIBridge like the other
      // milestones, not just discounted as part of one undifferentiated total.
      const coastNow = retirementAge >= PRESERVATION_AGE
        ? coastTarget(fi, Math.max(0, retirementAge - age), realR)
        : earlyFIBridge(effFull, supAll, yToPreserv, realR, realSupR, swr);
      const coastCheckW = retirementAge >= PRESERVATION_AGE ? total : accessible;

      if (!leanAge    && checkW >= leanTgt)    leanAge    = age;
      if (!coastAge   && coastCheckW >= coastNow) coastAge = age;
      if (!baristaAge && checkW >= baristaTgt) baristaAge = age;
      if (!fullAge    && checkW >= fullTgt)    fullAge    = age;

      rows.push({
        age, yr, infAdj, retired,
        totalReal: total, supReal: sup1 + sup2, sup1Real: sup1, sup2Real: sup2,
        invReal: inv, cashReal: cash,
        accessibleReal: accessible,
        coastNow, leanTgt, baristaTgt, fullTgt,
        annualSavings, sgContrib, extraConc, netSuperContrib, annualTax, invTax,
        pension: pensionY, supDraw, invDraw, cashDraw, householdNet,
        houseExpAdj,
      });
    }
  }

  if (light) return { totalsReal, failed, depleteAge };

  // Safety net for inverted expense configs (warned about separately)
  if (fullAge && !leanAge    && leanExpenses    <= fullExpenses) leanAge    = fullAge;
  if (fullAge && !baristaAge && baristaExpenses <= fullExpenses) baristaAge = fullAge;

  const bridgeAtRetirement = retirementAge >= PRESERVATION_AGE ? 0 : (() => {
    const retRow = rows.find(r => r.age === retirementAge);
    if (!retRow) return 0;
    // Use effective post-purchase expense level if house has been bought by retirement
    const effExp = Math.max(0, fullExpenses + (retRow.houseExpAdj ?? 0));
    return earlyFIBridge(effExp, retRow.supReal, PRESERVATION_AGE - retirementAge, realR, realSupR, swr);
  })();

  return {
    rows, totalsReal,
    milestones: { leanAge, coastAge, baristaAge, fullAge, retireBefore60: retirementAge < PRESERVATION_AGE, mortgagePaidAge },
    targets: {
      fi, leanFI,
      // At-retirement effective FI accounts for post-purchase expense change
      fiEff:     rows.find(r => r.age === retirementAge)?.fullTgt    ?? fi,
      leanFIEff: rows.find(r => r.age === retirementAge)?.leanTgt    ?? leanFI,
      baristaFI: rows[0] ? rows[0].baristaTgt : fiNumber(Math.max(0, baristaExpenses - baristaIncome), swr),
    },
    bridgeAtRetirement,
    currentTax: rows[0]?.annualTax || {},
    currentSavings: rows[0]?.annualSavings || 0,
    depleteAge, failed, helpPaidOffAge,
  };
}

// ══════════════════════════════════════════════════════════
//  MONTE CARLO  (seeded — results stable across recalcs)
// ══════════════════════════════════════════════════════════

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function runMonteCarlo(inp, nSims = 400) {
  if (!inp.retVol || inp.retVol <= 0) return null;
  const rand  = mulberry32(20260612);
  const years = 91 - inp.currentAge;
  const totals = [];
  let fails = 0;

  for (let s = 0; s < nSims; s++) {
    const zs = new Array(years);
    for (let i = 0; i < years; i += 2) {     // Box-Muller pairs
      const u1 = Math.max(rand(), 1e-9), u2 = rand();
      const m  = Math.sqrt(-2 * Math.log(u1));
      zs[i] = m * Math.cos(2 * Math.PI * u2);
      if (i + 1 < years) zs[i + 1] = m * Math.sin(2 * Math.PI * u2);
    }
    const res = project(inp, { light: true, shock: y => zs[y] ?? 0, vol: inp.retVol });
    if (res.failed) fails++;
    totals.push(res.totalsReal);
  }

  const pick = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const p10 = [], p90 = [];
  for (let y = 0; y < years; y++) {
    const col = totals.map(t => t[y]).sort((a, b) => a - b);
    p10.push(pick(col, 0.10));
    p90.push(pick(col, 0.90));
  }
  return { success: 1 - fails / nSims, p10, p90, n: nSims };
}

// ══════════════════════════════════════════════════════════
//  PARTNER / PRIMARY INDIVIDUAL PROJECTIONS
//  Each person modelled alone against the household FI goal.
// ══════════════════════════════════════════════════════════

function projectPartner(inp, p1Net) {
  if (!inp.couple || !inp.partnerAge) return null;
  return project({
    ...inp,
    currentAge:           inp.partnerAge,
    retirementAge:        inp.partnerRetirementAge,
    grossSalary:          inp.partnerSalary,
    partnerSalary:        0,
    couple:               false,
    hecsActive:           inp.partnerHecsActive,
    hecsBalance:          inp.partnerHecsBalance,
    partnerHecsActive:    false,
    superBalance:         inp.partnerSuperBalance,
    partnerSuperBalance:  0,
    investBalance:        inp.partnerInvestBalance || 0,
    cashBalance:          inp.partnerCashBalance   || 0,
    partnerInvestBalance: 0,
    partnerCashBalance:   0,
    // Each person pays their share of household expenses while both work;
    // FI targets stay household-level: "can partner's wealth sustain the household alone?"
    currentExpenses:      inp.currentExpenses * 0.5,
    extraConcessional:    inp.partnerExtraConcessional || 0,
    carryForwardCap:      inp.partnerCarryForwardCap || 0,
    partnerCarryForwardCap: 0,
    extraNonConcessional: 0,
    windfallAmount: 0, oneOffAmount: 0,
    leanExpenses:         Math.max(0, inp.leanExpenses - p1Net),
    baristaExpenses:      Math.max(0, inp.baristaExpenses - p1Net),
    fullExpenses:         Math.max(0, inp.fullExpenses - p1Net),
  });
}

function projectPrimary(inp, p2Net) {
  if (!inp.couple || inp.grossSalary <= 0) return null;
  return project({
    ...inp,
    partnerSalary:        0,
    couple:               false,
    partnerHecsActive:    false,
    partnerSuperBalance:  0,
    partnerCarryForwardCap: 0,
    partnerInvestBalance: 0,
    partnerCashBalance:   0,
    currentExpenses:      inp.currentExpenses * 0.5,
    windfallAmount: 0, oneOffAmount: 0,
    leanExpenses:         Math.max(0, inp.leanExpenses - p2Net),
    baristaExpenses:      Math.max(0, inp.baristaExpenses - p2Net),
    fullExpenses:         Math.max(0, inp.fullExpenses - p2Net),
  });
}

// ══════════════════════════════════════════════════════════
//  FORMATTING HELPERS
// ══════════════════════════════════════════════════════════

const fmt  = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-AU');
const fmtK = n => n == null ? '—' : (n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : '$' + Math.round(n / 1000) + 'K');
const pct  = n => (n * 100).toFixed(1) + '%';

// ══════════════════════════════════════════════════════════
//  PERSISTENCE & SHARING
// ══════════════════════════════════════════════════════════

const STORAGE_KEY = 'au-fire-calc-v3';

function collectFormValues() {
  const vals = {};
  // Best practice: Only save core inputs, ignore temporary UI state like What-If sliders
  document.querySelectorAll('.input-panel input[id], .input-panel select[id]').forEach(el => {
    vals[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return vals;
}

function applyFormValues(vals) {
  Object.entries(vals).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = (val === true || val === 'true' || val === '1');
    } else {
      // Best practice: Sanitize loaded values against expected limits
      if (el.type === 'number' || el.type === 'range') {
        const num = parseFloat(val);
        if (!isNaN(num) && el.min && num < parseFloat(el.min)) val = el.min;
        if (!isNaN(num) && el.max && num > parseFloat(el.max)) val = el.max;
      }
      el.value = val;
    }
  });
}

function saveState() {
  try {
    const data = JSON.stringify(collectFormValues());
    localStorage.setItem(STORAGE_KEY, data);
    // Also save to a cookie that expires in 1 year (31,536,000 seconds)
    document.cookie = `${STORAGE_KEY}=${encodeURIComponent(data)}; max-age=31536000; path=/; SameSite=Strict`;
  } catch (_) {}
}

function loadState() {
  try {
    let savedStr = null;
    const cookieMatch = document.cookie.match(new RegExp('(^| )' + STORAGE_KEY + '=([^;]+)'));
    if (cookieMatch) savedStr = decodeURIComponent(cookieMatch[2]);
    if (!savedStr) savedStr = localStorage.getItem(STORAGE_KEY);

    const saved = JSON.parse(savedStr);
    if (!saved) return false;
    applyFormValues(saved);
    return true;
  } catch (_) { return false; }
}

function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) return false;
  const vals = {};
  p.forEach((val, id) => { vals[id] = val; });
  applyFormValues(vals);
  return true;
}

function shareLink() {
  const p = new URLSearchParams();
  document.querySelectorAll('.input-panel input[id], .input-panel select[id]').forEach(el => {
    p.set(el.id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
  });
  const url = location.origin + location.pathname + '?' + p.toString();
  const btn = document.getElementById('share-btn');
  const done = () => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => prompt('Copy this link:', url));
  else prompt('Copy this link:', url);
}

function copyAuditLogs() {
  if (!window._lastAuditLog) return alert('No logs generated yet.');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(window._lastAuditLog).then(() => {
      alert('✅ Diagnostic audit logs copied to clipboard!');
    }).catch(() => {
      prompt('Your browser blocked clipboard access. Copy the logs here:', window._lastAuditLog);
    });
  } else {
    prompt('Copy the logs here:', window._lastAuditLog);
  }
}

function resetDefaults() {
  if (!confirm('Reset all inputs to defaults?')) return;
  localStorage.removeItem(STORAGE_KEY);
  document.cookie = `${STORAGE_KEY}=; max-age=0; path=/; SameSite=Strict`;
  location.href = location.pathname; // also clears any shared-link params
}

function exportCSV() {
  if (!_lastRows.length) return;
  const cols = ['Age', 'Phase', 'Net income', 'Tax', 'Savings to investments', 'Net super contributions',
    'Age pension', 'Super drawdown', 'Investment drawdown', 'Cash drawdown',
    'Super balance', 'Investments', 'Cash', 'Total wealth'];
  const lines = [cols.join(',')];
  _lastRows.forEach(r => {
    lines.push([
      r.age, r.retired ? 'Retired' : 'Working',
      Math.round(r.annualTax.net ?? r.householdNet),
      Math.round((r.annualTax.total ?? 0) + (r.invTax ?? 0)),
      Math.round(r.annualSavings), Math.round(r.netSuperContrib),
      Math.round(r.pension), Math.round(r.supDraw), Math.round(r.invDraw), Math.round(r.cashDraw),
      Math.round(r.supReal), Math.round(r.invReal), Math.round(r.cashReal), Math.round(r.totalReal),
    ].join(','));
  });
  const blob = new Blob(["All values in today's dollars\n" + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fire-projection.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════════
//  DARK MODE
// ══════════════════════════════════════════════════════════

function isDark() { return document.body.classList.contains('dark'); }

function toggleDark() {
  const dark = document.body.classList.toggle('dark');
  localStorage.setItem('au-fire-dark', dark ? '1' : '0');
  document.cookie = `au-fire-dark=${dark ? '1' : '0'}; max-age=31536000; path=/; SameSite=Strict`;
  document.getElementById('dark-toggle').textContent = dark ? '☀️' : '🌙';
  Chart.defaults.color = dark ? '#9CA3AF' : '#718096';
  _calc();
}

function initDark() {
  let darkStr = null;
  const cookieMatch = document.cookie.match(/(^| )au-fire-dark=([^;]+)/);
  if (cookieMatch) darkStr = cookieMatch[2];
  if (!darkStr) darkStr = localStorage.getItem('au-fire-dark');

  const dark = darkStr === '1';
  if (dark) {
    document.body.classList.add('dark');
    Chart.defaults.color = '#9CA3AF';
  }
  const btn = document.getElementById('dark-toggle');
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
}

// ══════════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════════

function toggleSection(id) {
  document.getElementById(id).classList.toggle('collapsed');
}

function toggleVis(id, show) {
  const el = document.getElementById(id);
  if (el) el.style.display = show ? 'block' : 'none';
}

function syncRange(el, lblId, pre, suf) {
  const v = parseFloat(el.value);
  document.getElementById(lblId).textContent = pre + v + suf;
  const min = parseFloat(el.min), max = parseFloat(el.max);
  el.style.setProperty('--val', ((v - min) / (max - min) * 100).toFixed(1) + '%');
}

function updateRangeLabels() {
  [
    ['currentAge',           'lbl-age',            '', ''],
    ['retirementAge',        'lbl-retire',         '', ''],
    ['partnerAge',           'lbl-partner-age',    '', ''],
    ['partnerRetirementAge', 'lbl-partner-retire', '', ''],
    ['investReturn',         'lbl-ret',            '', '%'],
    ['superReturn',          'lbl-supret',         '', '%'],
    ['cashReturn',           'lbl-cash',           '', '%'],
    ['inflation',            'lbl-inf',            '', '%'],
    ['swr',                  'lbl-swr',            '', '%'],
    ['sgRate',               'lbl-sg',             '', '%'],
    ['taxableShare',         'lbl-share',          '', '%'],
    ['retVol',               'lbl-vol',            '', '%'],
    ['slowGoPct',            'lbl-slow',           '', '%'],
  ].forEach(([id, lbl, pre, suf]) => {
    const el = document.getElementById(id);
    if (el) syncRange(el, lbl, pre, suf);
  });
}

function updateCoupleUI(isCouple) {
  ['partner-profile-fields', 'partner-income-fields', 'partner-wealth-fields', 'partner-section']
    .forEach(id => toggleVis(id, isCouple));
  
  document.querySelectorAll('.hh-tag').forEach(el => {
    el.textContent = isCouple ? 'household total' : 'your total';
  });
  
  const lbl = document.getElementById('main-milestones-label');
  if (lbl) {
    lbl.innerHTML = isCouple ? 'Household FIRE Milestones <span class="section-label-note">combined wealth</span>' 
      : 'Your FIRE Milestones';
  }
}

function updateConditionalUI() {
  toggleVis('hecs-balance-field',   document.getElementById('hasHECS')?.checked);
  toggleVis('p-hecs-balance-field', document.getElementById('partnerHasHECS')?.checked);
  toggleVis('house-purchase-fields', document.getElementById('planHousePurchase')?.checked);
}

function getInputs() {
  const g   = id => document.getElementById(id);
  const num = id => { const el = g(id); return el ? (parseFloat(el.value) || 0) : 0; };
  const chk = id => { const el = g(id); return el ? el.checked : false; };
  const sel = id => { const el = g(id); return el ? el.value : ''; };

  const couple     = sel('status') === 'couple';
  const partnerAge = parseInt(g('partnerAge')?.value, 10) || 30;
  const rawPRetire = parseInt(g('partnerRetirementAge')?.value, 10) || 55;
  const partnerRetirementAge = Math.max(partnerAge + 1, rawPRetire);

  const hasHECS            = chk('hasHECS');
  const hecsBalance        = num('hecsBalance');
  const partnerHasHECS     = chk('partnerHasHECS');
  const partnerHecsBalance = num('partnerHecsBalance');

  const planHousePurchase = chk('planHousePurchase');

  return {
    currentAge:    parseInt(g('currentAge').value, 10),
    retirementAge: parseInt(g('retirementAge').value, 10),
    grossSalary:   num('grossSalary'),
    partnerSalary: couple ? num('partnerSalary') : 0,
    sgRate:        num('sgRate') / 100,
    extraConcessional:        num('extraConcessional'),
    extraNonConcessional:     num('extraNonConcessional'),
    partnerExtraConcessional: couple ? num('partnerExtraConcessional') : 0,
    carryForwardCap:          num('carryForwardCap'),
    partnerCarryForwardCap:   couple ? num('partnerCarryForwardCap') : 0,
    currentExpenses:  num('currentExpenses'),
    leanExpenses:     num('leanExpenses'),
    baristaExpenses:  num('baristaExpenses'),
    baristaIncome:    num('baristaIncome'),
    baristaStopAge:   num('baristaStopAge') || 65,
    fullExpenses:     num('fullExpenses'),
    superBalance:         num('superBalance'),
    partnerSuperBalance:  couple ? num('partnerSuperBalance') : 0,
    investBalance:        num('investBalance'),
    cashBalance:          num('cashBalance'),
    partnerInvestBalance: couple ? num('partnerInvestBalance') : 0,
    partnerCashBalance:   couple ? num('partnerCashBalance') : 0,
    investReturn:  num('investReturn') / 100,
    superReturn:   num('superReturn')  / 100,
    cashReturn:    num('cashReturn')   / 100,
    inflation:     num('inflation')    / 100,
    swr:           num('swr')          / 100,
    taxableShare:  num('taxableShare') / 100,
    retVol:        num('retVol')       / 100,
    investHolder:  sel('investHolder') || 'lower',
    contribTarget: sel('contribTarget') || 'mine',
    includeAgePension: chk('includeAgePension'),
    homeowner:         sel('homeowner') === 'yes',
    couple,
    hasHECS, hecsBalance,
    hecsActive: hasHECS && hecsBalance > 0,
    partnerHasHECS, partnerHecsBalance,
    partnerHecsActive: couple && partnerHasHECS && partnerHecsBalance > 0,
    privateHealth: chk('privateHealth'),
    growSalary:    chk('salaryGrowth'),
    partnerAge,
    partnerRetirementAge,
    slowGoAge:      num('slowGoAge') || 75,
    slowGoPct:      num('slowGoPct') / 100,
    windfallAmount: num('windfallAmount'),
    windfallAge:    num('windfallAge'),
    oneOffAmount:   num('oneOffAmount'),
    oneOffAge:      num('oneOffAge'),
    planHousePurchase,
    houseDeposit:   planHousePurchase ? num('houseDeposit') : 0,
    houseBuyAge:    planHousePurchase ? (num('houseBuyAge') || 40) : 0,
    mortgageAmount: planHousePurchase ? num('mortgageAmount') : 0,
    rentSaving:     planHousePurchase ? num('rentSaving') : 0,
    mortgageRate:   planHousePurchase ? num('mortgageRate') / 100 : 0,
    mortgageTerm:   planHousePurchase ? (num('mortgageTerm') || 30) : 0,
  };
}

const taxOpts = inp => ({
  noPHI: !inp.privateHealth,
  family: inp.couple,
  mlsCombined: inp.grossSalary + inp.partnerSalary,
});

// ══════════════════════════════════════════════════════════
//  CHARTS
// ══════════════════════════════════════════════════════════

const charts = {};

Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
Chart.defaults.font.size   = 11;
Chart.defaults.color       = '#718096';

// Vertical milestone marker lines on the projection chart
const msLinesPlugin = {
  id: 'msLines',
  afterDatasetsDraw(chart, args, options) {
    const lines = options.lines || [];
    const xs = chart.scales.x, area = chart.chartArea, ctx = chart.ctx;
    lines.forEach(({ idx, color, label }) => {
      if (idx == null || idx < 0) return;
      const px = xs.getPixelForValue(idx);
      if (px < area.left || px > area.right) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, area.top);
      ctx.lineTo(px, area.bottom);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = '600 9px sans-serif';
      ctx.textAlign = 'left';
      ctx.translate(px, area.top);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(label, 4, -4);
      ctx.restore();
    });
  },
};
Chart.register(msLinesPlugin);

function gc() { return isDark() ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)'; }

function makeGradient(ctx, color, alpha1 = 0.3, alpha2 = 0.01) {
  const g = ctx.createLinearGradient(0, 0, 0, 300);
  g.addColorStop(0, color.replace('1)', `${alpha1})`));
  g.addColorStop(1, color.replace('1)', `${alpha2})`));
  return g;
}

function buildProjectionChart(data, milestones, targets, inp, mc) {
  const ctx  = document.getElementById('chart-projection').getContext('2d');
  const ages = data.map(r => r.age);
  const titleEl = document.getElementById('projection-chart-title');
  if (titleEl) titleEl.textContent = inp.couple
    ? 'Household Net Worth Projection to Age 90 (your age)'
    : 'Net Worth Projection to Age 90';
  const G    = gc();
  const firstAge = data[0].age;
  const isD = isDark();

  const totalGrad  = makeGradient(ctx, isD ? 'rgba(167,139,250,1)' : 'rgba(124,58,237,1)', 0.25, 0.02);
  const superGrad  = makeGradient(ctx, isD ? 'rgba(251,191,36,1)' : 'rgba(180,83,9,1)',   0.20, 0.01);
  const investGrad = makeGradient(ctx, isD ? 'rgba(96,165,250,1)' : 'rgba(37,99,235,1)',  0.20, 0.01);

  const ds = [
    { label: 'Total Wealth', data: data.map(r => r.totalReal), borderColor: isD ? '#A78BFA' : '#7C3AED', backgroundColor: totalGrad, fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5 },
    { label: 'Super',        data: data.map(r => r.supReal),   borderColor: isD ? '#FBBF24' : '#B45309', backgroundColor: superGrad, fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4 },
    { label: 'Investments',  data: data.map(r => r.invReal),   borderColor: isD ? '#60A5FA' : '#2563EB', backgroundColor: investGrad, fill: true, tension: 0.4, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4 },
    { label: 'Coast Target', data: data.map(r => r.coastNow),  borderColor: isD ? '#60A5FA' : '#2563EB', backgroundColor: 'transparent', fill: false, tension: 0.2, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
    { label: `Full FIRE target (${fmtK(targets.fiEff)})`,    data: data.map(r => r.fullTgt),    borderColor: isD ? 'rgba(167,139,250,0.55)' : 'rgba(124,58,237,0.55)', fill: false, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
    { label: `Lean FIRE target (${fmtK(targets.leanFIEff)})`, data: data.map(r => r.leanTgt),   borderColor: isD ? 'rgba(248,113,113,0.55)' : 'rgba(220,38,38,0.55)',  fill: false, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
    { label: 'Barista FIRE target',                        data: data.map(r => r.baristaTgt), borderColor: isD ? 'rgba(52,211,153,0.55)' : 'rgba(5,150,105,0.55)', fill: false, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
  ];

  if (mc) {
    ds.push(
      { label: '_p90', data: mc.p90, borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: isD ? 'rgba(167,139,250,0.12)' : 'rgba(124,58,237,0.08)', tension: 0.4 },
      { label: '_p10', data: mc.p10, borderWidth: 0, pointRadius: 0, fill: false, tension: 0.4 },
    );
  }

  const msLines = [
    { age: milestones.leanAge,         color: isD ? '#F87171' : '#DC2626', label: 'Lean' },
    { age: milestones.coastAge,        color: isD ? '#60A5FA' : '#2563EB', label: 'Coast' },
    { age: milestones.baristaAge,      color: isD ? '#34D399' : '#059669', label: 'Barista' },
    { age: milestones.fullAge,         color: isD ? '#A78BFA' : '#7C3AED', label: 'Full' },
    { age: inp.retirementAge,          color: isD ? '#D1D5DB' : '#9CA3AF', label: 'Retire' },
    { age: inp.houseBuyAge > 0 && (inp.houseDeposit > 0 || inp.mortgageAmount > 0) ? inp.houseBuyAge : null, color: isD ? '#FBBF24' : '#D97706', label: '🏠 Buy' },
    { age: milestones.mortgagePaidAge, color: isD ? '#FBBF24' : '#D97706', label: '🏠 Free' },
  ].filter(l => l.age != null && l.age >= firstAge)
   .map(l => ({ idx: l.age - firstAge, color: l.color, label: l.label }));

  if (charts.proj) charts.proj.destroy();
  charts.proj = new Chart(ctx, {
    type: 'line', data: { labels: ages, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        msLines: { lines: msLines },
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, padding: 10, font: { size: 11 }, filter: i => !i.text.startsWith('_') },
        },
        tooltip: {
          filter: item => !item.dataset.label.startsWith('_'),
          callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` },
        },
      },
      scales: {
        x: { title: { display: true, text: 'Age', font: { size: 11 } }, grid: { color: G } },
        y: {
          title: { display: true, text: "Wealth (today's $)", font: { size: 11 } },
          grid: { color: G },
          ticks: { callback: v => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + (v / 1000).toFixed(0) + 'K' },
        },
      },
    },
  });
}

function buildTimelineChart(milestones, currentAge, partnerMilestones, partnerAge) {
  const ctx    = document.getElementById('chart-timeline').getContext('2d');
  const labels = ['Lean', 'Coast', 'Barista', 'Full'];
  const isD    = isDark();
  const colors = isD ? ['#F87171', '#60A5FA', '#34D399', '#A78BFA'] : ['#DC2626', '#2563EB', '#059669', '#7C3AED'];
  const ages1  = [milestones.leanAge, milestones.coastAge, milestones.baristaAge, milestones.fullAge];

  const datasets = [{
    label: 'You',
    data: ages1.map(a => a ?? null),
    backgroundColor: colors.map(c => c + 'CC'), borderColor: colors,
    borderWidth: 2, borderRadius: 6,
  }];

  if (partnerMilestones && partnerAge) {
    const ages2 = [partnerMilestones.leanAge, partnerMilestones.coastAge, partnerMilestones.baristaAge, partnerMilestones.fullAge];
    datasets.push({
      label: 'Partner',
      data: ages2.map(a => a ?? null),
      backgroundColor: colors.map(c => c + '55'), borderColor: colors,
      borderWidth: 2, borderRadius: 6, borderDash: [4, 4],
    });
  }

  if (charts.timeline) charts.timeline.destroy();
  charts.timeline = new Chart(ctx, {
    type: 'bar', data: { labels, datasets },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { display: !!partnerMilestones, position: 'bottom', labels: { boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: {
          label: c => c.parsed.x == null ? ` ${c.dataset.label}: not reached`
            : ` ${c.dataset.label}: age ${c.parsed.x} (${Math.round(c.parsed.x - (c.datasetIndex === 0 ? currentAge : partnerAge))} yrs away)`,
        }},
      },
      scales: {
        x: { title: { display: true, text: 'Age', font: { size: 11 } }, min: Math.min(currentAge, partnerAge || currentAge), max: 90, grid: { color: gc() } },
        y: { grid: { display: false } },
      },
    },
  });
}

function buildIncomeChart(inp, result) {
  const ctx = document.getElementById('chart-income').getContext('2d');
  const row = result.rows.find(r => r.age === inp.retirementAge) || result.rows[result.rows.length - 1];

  const effRetireExp = Math.max(0, inp.fullExpenses + (row?.houseExpAdj ?? 0));
  const expReal  = effRetireExp * (inp.slowGoPct > 0 && inp.retirementAge >= inp.slowGoAge ? 1 - inp.slowGoPct : 1);
  const pensionY = row?.pension ?? 0;
  const partnerY = row?.householdNet ?? 0;
  const fromPort = Math.max(0, expReal - pensionY - partnerY);

  const subEl = document.getElementById('income-chart-sub');
  if (subEl) subEl.textContent = inp.couple
    ? `Household expenses in your first year of retirement (your age ${inp.retirementAge}), today's dollars — partner may still be working`
    : `First year of your retirement (age ${inp.retirementAge}), today's dollars (Age Pension starts at 67)`;

  const raw    = [fromPort, partnerY, pensionY];
  const labels = ['Household Portfolio Drawdown', 'Partner Salary (still working)', 'Age Pension'];
  const isD    = isDark();
  const colors = isD ? ['#A78BFA', '#60A5FA', '#FBBF24'] : ['#7C3AED', '#2563EB', '#F59E0B'];
  const vals   = raw.map((v, i) => ({ v, l: labels[i], c: colors[i] })).filter(x => x.v > 0);

  if (charts.income) charts.income.destroy();
  charts.income = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: vals.map(x => x.l), datasets: [{ data: vals.map(x => x.v), backgroundColor: vals.map(x => x.c + 'CC'), borderColor: vals.map(x => x.c), borderWidth: 2, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.parsed)} (${(c.parsed / Math.max(1, expReal) * 100).toFixed(0)}%)` } },
      },
    },
  });
}

function buildTaxChart(p1Tax, p1Salary, p1SG) {
  const ctx     = document.getElementById('chart-tax').getContext('2d');
  const takePay = p1Tax.p1Net  ?? p1Tax.net  ?? 0;
  const rawTax  = p1Tax.p1Raw  ?? p1Tax.raw  ?? 0;
  const hecs    = p1Tax.p1Hecs ?? p1Tax.hecs ?? 0;
  const superY  = p1SG;

  const raw    = [takePay, rawTax, hecs, superY];
  const labels = ['Take-Home', 'Tax + Medicare', 'HECS/HELP', 'Employer Super'];
  const isD    = isDark();
  const colors = isD ? ['#34D399', '#F87171', '#FCD34D', '#FBBF24'] : ['#059669', '#DC2626', '#F59E0B', '#B45309'];
  const vals   = raw.map((v, i) => ({ v, l: labels[i], c: colors[i] })).filter(x => x.v > 0);

  if (charts.tax) charts.tax.destroy();
  charts.tax = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: vals.map(x => x.l), datasets: [{ data: vals.map(x => x.v), backgroundColor: vals.map(x => x.c + 'CC'), borderColor: vals.map(x => x.c), borderWidth: 2, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.parsed)} (${(c.parsed / (p1Salary + superY) * 100).toFixed(1)}%)` } },
      },
    },
  });
}

function buildSavingsChart(data, retirementAge, partnerRetirementAge, inp) {
  const ctx = document.getElementById('chart-savings').getContext('2d');
  // Show savings up to the later retirement — partner may keep contributing after primary retires
  const cutoffAge = inp?.couple && inp.partnerRetirementAge
    ? Math.max(retirementAge, inp.currentAge + (inp.partnerRetirementAge - inp.partnerAge))
    : retirementAge;
  const working = data.filter(r => r.age < cutoffAge);

  const subEl = document.getElementById('savings-chart-sub');
  if (subEl) subEl.textContent = inp?.couple
    ? `Household super contributions and investment savings up to the later of your two retirements, today's dollars`
    : `Super vs non-super contributions each year, today's dollars`;
  const G       = gc();
  const isD     = isDark();

  if (charts.savings) charts.savings.destroy();
  charts.savings = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: working.map(r => r.age),
      datasets: [
        { label: 'Super Contributions (net)', data: working.map(r => r.netSuperContrib), backgroundColor: isD ? 'rgba(251,191,36,0.7)' : 'rgba(180,83,9,0.7)',  borderColor: isD ? '#FBBF24' : '#B45309', borderWidth: 1, borderRadius: 2 },
        { label: 'Investment Savings',         data: working.map(r => r.annualSavings),   backgroundColor: isD ? 'rgba(96,165,250,0.7)' : 'rgba(37,99,235,0.7)', borderColor: isD ? '#60A5FA' : '#2563EB', borderWidth: 1, borderRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10 } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: {
        x: { stacked: true, title: { display: true, text: 'Age', font: { size: 11 } }, grid: { display: false } },
        y: { stacked: true, grid: { color: G }, ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'K' } },
      },
    },
  });
}

// ══════════════════════════════════════════════════════════
//  HERO HEADLINE & WARNINGS
// ══════════════════════════════════════════════════════════

function renderHero(inp, result, mc, warnings) {
  const el = document.getElementById('hero');
  if (!el) return;
  const m = result.milestones;
  const CY = new Date().getFullYear();

  const kicker = inp.couple ? 'Your household path to FIRE' : 'Your path to FIRE';

  const head = m.fullAge != null
    ? `Full FIRE at <b>${m.fullAge}</b>${m.fullAge <= inp.currentAge
        ? ' — <span class="hero-achieved">already there 🎉</span>'
        : ` — ${m.fullAge - inp.currentAge} years away (${CY + m.fullAge - inp.currentAge})`}`
    : `Full FIRE isn't reached by age 90 with current assumptions`;

  const ageNote = inp.couple
    ? `<span style="font-size:12px;font-weight:400;opacity:0.7"> (your age ${m.fullAge}, combined wealth)</span>`
    : '';

  const chip = (label, age) =>
    `<span class="chip">${label} <b>${age == null ? '90+' : age}</b></span>`;

  let mcChip = '';
  if (mc) {
    const s = Math.round(mc.success * 100);
    const cls = s >= 85 ? 'good' : s >= 70 ? 'ok' : 'bad';
    mcChip = `<span class="chip mc-badge ${cls}" title="Share of ${mc.n} simulated market histories where the household plan never runs out of money before age 90">Monte Carlo: <b>${s}%</b> success</span>`;
  }

  const helpChip = result.helpPaidOffAge != null && inp.hecsActive
    ? `<span class="chip">Your HECS paid off at <b>${result.helpPaidOffAge}</b></span>` : '';

  const mortgageChip = m.mortgagePaidAge != null
    ? `<span class="chip">🏠 Mortgage-free at <b>${m.mortgagePaidAge}</b></span>` : '';

  el.innerHTML = `
    <div class="hero-kicker">${kicker}</div>
    <div class="hero-headline">${head}${m.fullAge != null && inp.couple ? ageNote : ''}</div>
    <div class="hero-chips">
      ${chip('Lean', m.leanAge)}${chip('Coast', m.coastAge)}${chip('Barista', m.baristaAge)}
      ${helpChip}${mortgageChip}${mcChip}
    </div>
    ${warnings.length ? `<div class="hero-warnings">${warnings.map(w => `<div class="warn">⚠ ${w}</div>`).join('')}</div>` : ''}
  `;
}

function buildWarnings(inp, result) {
  const warnings = [];
  if (inp.leanExpenses > inp.fullExpenses || inp.baristaExpenses > inp.fullExpenses)
    warnings.push('Expense levels look out of order — expected Lean ≤ Barista ≤ Full annual expenses.');

  const r0 = result.rows[0];
  if (r0 && !r0.retired) {
    const gap = inp.currentExpenses + Math.min(inp.extraNonConcessional, NON_CONCESSIONAL_CAP) - (r0.annualTax.net ?? 0);
    if (gap > 1)
      warnings.push(`Spending exceeds take-home pay by ${fmt(gap)}/yr — the shortfall is drawn from savings.`);
  }

  if (result.depleteAge != null)
    warnings.push(`Portfolio runs dry at age ${result.depleteAge} under base assumptions.`);

  // House purchase warnings
  if (inp.houseDeposit > 0 || inp.mortgageAmount > 0) {
    if (inp.houseBuyAge <= inp.currentAge)
      warnings.push('House buy age is at or before your current age — the purchase is treated as already done (deposit drawn immediately).');
    const repay = annualMortgageRepayment(inp.mortgageAmount, inp.mortgageRate, inp.mortgageTerm);
    if (repay > 0 && repay > inp.rentSaving)
      warnings.push(`Mortgage repayments (${fmt(repay)}/yr) exceed your rent saving (${fmt(inp.rentSaving)}/yr) — expenses increase by ${fmt(repay - inp.rentSaving)}/yr during the mortgage.`);
    if (inp.mortgageAmount > 0 && inp.rentSaving === 0)
      warnings.push('Rent saving is $0 — set this to the annual rent your expenses will no longer include after buying, so the model can net off the cost correctly.');
  }

  // Transfer balance cap is per person
  const r60p1 = result.rows.find(r => r.age === PRESERVATION_AGE);
  if (r60p1 && r60p1.sup1Real > TRANSFER_BALANCE_CAP)
    warnings.push(`Your projected super at 60 (${fmtK(r60p1.sup1Real)} today's $) exceeds the $2.0M transfer balance cap — earnings above the cap stay taxed at 15%.`);
  if (inp.couple) {
    // Partner is age 60 when primary (who starts the projection) is age: currentAge + (60 - partnerAge)
    const p2At60PrimaryAge = inp.currentAge + (PRESERVATION_AGE - inp.partnerAge);
    const r60p2 = result.rows.find(r => r.age === p2At60PrimaryAge);
    if (r60p2 && r60p2.sup2Real > TRANSFER_BALANCE_CAP)
      warnings.push(`Partner's projected super at their 60 (${fmtK(r60p2.sup2Real)} today's $) exceeds the $2.0M transfer balance cap.`);
  }

  return warnings;
}

// ══════════════════════════════════════════════════════════
//  MILESTONE CARD RENDERING
// ══════════════════════════════════════════════════════════

function renderCard(prefix, age, currentAge, fiNum, descLines, progressPct) {
  const yearsAway = age == null ? null : age - currentAge;
  const ageEl  = document.getElementById(`${prefix}-age`);
  const yrsEl  = document.getElementById(`${prefix}-years`);
  const numEl  = document.getElementById(`${prefix}-number`);
  const descEl = document.getElementById(`${prefix}-desc`);
  const barEl  = document.getElementById(`${prefix}-bar`);
  const pctEl  = document.getElementById(`${prefix}-pct`);
  if (!ageEl) return;

  ageEl.textContent = age == null ? '90+' : age;
  yrsEl.innerHTML = age == null
    ? '<span class="mc-na">Not reached by 90</span>'
    : yearsAway <= 0
      ? '<span class="mc-achieved">✓ Achieved!</span>'
      : `${yearsAway} year${yearsAway !== 1 ? 's' : ''} away`;
  numEl.textContent  = fmtK(fiNum);
  descEl.innerHTML   = descLines;

  const clampedPct = Math.min(100, Math.max(0, progressPct || 0));
  if (barEl) barEl.style.width = clampedPct.toFixed(1) + '%';
  if (pctEl) pctEl.textContent = clampedPct.toFixed(0) + '% funded';
}

// ══════════════════════════════════════════════════════════
//  JOINT RETIREMENT ANALYSIS
// ══════════════════════════════════════════════════════════

function renderJointSummary(inp, p1Milestones, p2Milestones) {
  const el = document.getElementById('joint-summary');
  if (!el) return;

  const p1Full = p1Milestones.fullAge;
  const p2Full = p2Milestones.fullAge;

  if (!p1Full && !p2Full) {
    el.innerHTML = `<p class="joint-none">Neither reaches Full FIRE by age 90 with current assumptions.</p>`;
    return;
  }

  const p1YearsToFull = p1Full != null ? p1Full - inp.currentAge : null;
  const p2YearsToFull = p2Full != null ? p2Full - inp.partnerAge  : null;

  const currentYear = new Date().getFullYear();
  const p1CalYear = p1YearsToFull != null ? currentYear + p1YearsToFull : null;
  const p2CalYear = p2YearsToFull != null ? currentYear + p2YearsToFull : null;

  let firstLabel, firstYear, firstAge, secondLabel, secondYear, gapYears;
  if (p1CalYear != null && (p2CalYear == null || p1CalYear <= p2CalYear)) {
    firstLabel = 'You'; firstYear = p1CalYear; firstAge = p1Full;
    secondLabel = 'Partner'; secondYear = p2CalYear; gapYears = p2CalYear != null ? p2CalYear - p1CalYear : null;
  } else {
    firstLabel = 'Partner'; firstYear = p2CalYear; firstAge = p2Full;
    secondLabel = 'You'; secondYear = p1CalYear; gapYears = p1CalYear != null ? p1CalYear - p2CalYear : null;
  }

  const jointYear  = p1CalYear != null && p2CalYear != null ? Math.max(p1CalYear, p2CalYear) : (p1CalYear ?? p2CalYear);
  const jointYears = jointYear != null ? jointYear - currentYear : null;

  // Sequential advantage: while one partner works, the household only needs the gap funded
  const p1Sac = Math.min(inp.extraConcessional, Math.max(0, CONCESSIONAL_CAP - inp.grossSalary * inp.sgRate));
  const p2Sac = Math.min(inp.partnerExtraConcessional, Math.max(0, CONCESSIONAL_CAP - inp.partnerSalary * inp.sgRate));
  const p1NetNow = calcTax(inp.grossSalary, p1Sac, inp.hecsActive, taxOpts(inp)).net;
  const p2NetNow = calcTax(inp.partnerSalary, p2Sac, inp.partnerHecsActive, taxOpts(inp)).net;

  // Use effective retirement-phase expenses for FI comparisons in the strategy note
  const effFullRet = houseExpAdjAt(inp, inp.retirementAge);

  const seqFI_partnerRetires = Math.max(0, effFullRet - p1NetNow) / inp.swr;
  const seqFI_primaryRetires = Math.max(0, effFullRet - p2NetNow) / inp.swr;
  const householdFI = effFullRet / inp.swr;

  const strategyNote = () => {
    if (seqFI_partnerRetires <= 0) return `<div class="joint-strategy">
      <span class="js-icon">🎉</span>
      Your salary alone covers all household expenses (today's $), so your partner can retire any time — they need <strong>zero portfolio</strong> to cover the gap.
    </div>`;
    if (seqFI_primaryRetires <= 0) return `<div class="joint-strategy">
      <span class="js-icon">🎉</span>
      Partner's salary alone covers all household expenses, so you can retire any time once your super&thinsp;/&thinsp;investments are in place.
    </div>`;

    if (gapYears && gapYears > 0) {
      const whoRetires = firstLabel;
      const whoWorks   = secondLabel;
      const seqFI      = firstLabel === 'You' ? seqFI_primaryRetires : seqFI_partnerRetires;
      const fullFI     = fmtK(householdFI);
      const seqFIStr   = fmtK(seqFI);
      const pctReduced = (seqFI / householdFI * 100).toFixed(0);
      return `<div class="joint-strategy">
        <span class="js-icon">💡</span>
        <div><strong>Sequential advantage:</strong> When ${whoRetires} retires first, ${whoWorks} keeps working and covers ${fmt(firstLabel === 'You' ? p2NetNow : p1NetNow)}/yr in expenses. ${whoRetires} only needs <strong>${seqFIStr}</strong> (${pctReduced}% of the ${fullFI} full FI number) — a meaningfully lower bar. This could bring ${whoRetires}'s retirement <em>earlier</em> than shown above.</div>
      </div>`;
    }
    return '';
  };

  el.innerHTML = `
    <div class="joint-comparison">
      <div class="joint-person-box">
        <div class="jp-who">You</div>
        <div class="jp-big-age" style="color:var(--full)">${p1Full ?? '90+'}</div>
        <div class="jp-small">Full FIRE age</div>
        <div class="jp-cal">${p1CalYear != null ? `${p1CalYear} · ${p1YearsToFull} yrs` : 'Not reached'}</div>
      </div>
      <div class="joint-divider-v"></div>
      <div class="joint-person-box">
        <div class="jp-who">Partner</div>
        <div class="jp-big-age" style="color:var(--coast)">${p2Full ?? '90+'}</div>
        <div class="jp-small">Full FIRE age</div>
        <div class="jp-cal">${p2CalYear != null ? `${p2CalYear} · ${p2YearsToFull} yrs` : 'Not reached'}</div>
      </div>
    </div>
    <div class="joint-outcome">
      <div class="jo-row">
        <span class="jo-label">First retirement</span>
        <span class="jo-val">${firstLabel} — ${firstYear ? `${firstYear} (age ${firstAge})` : 'not reached'}</span>
      </div>
      ${gapYears != null && gapYears > 0 ? `<div class="jo-row">
        <span class="jo-label">Retirement gap</span>
        <span class="jo-val">${gapYears} year${gapYears !== 1 ? 's' : ''} between retirements</span>
      </div>` : ''}
      <div class="jo-row highlight">
        <span class="jo-label">Both fully retired</span>
        <span class="jo-val">${jointYear ? `${jointYear} · ${jointYears} years from now` : 'Not reached by 90'}</span>
      </div>
    </div>
    ${strategyNote()}
  `;
}

// ══════════════════════════════════════════════════════════
//  INTERACTIVE WHAT-IF & OPTIMIZATIONS
// ══════════════════════════════════════════════════════════

function renderWhatIf(inp, result) {
  const youSlider = document.getElementById('wi-you-retire');
  const partnerSlider = document.getElementById('wi-partner-retire');
  const partnerContainer = document.getElementById('wi-partner-container');

  if (!youSlider || !partnerSlider || !partnerContainer) return;

  youSlider.min = inp.currentAge + 1;
  youSlider.max = 75;
  youSlider.value = inp.retirementAge;
  syncRange(youSlider, 'wi-you-val', '', '');

  if (inp.couple) {
    partnerSlider.min = inp.partnerAge + 1;
    partnerSlider.max = 75;
    partnerSlider.value = inp.partnerRetirementAge;
    syncRange(partnerSlider, 'wi-partner-val', '', '');
    partnerContainer.style.display = 'block';
  } else {
    partnerContainer.style.display = 'none';
  }

  runWhatIf();
}

window.runWhatIf = function() {
  const inp = _lastInp;
  if (!inp) return;
  const baseRes = project(inp);
  const baseW90 = baseRes.totalsReal[baseRes.totalsReal.length - 1] || 0;

  const youEl = document.getElementById('wi-you-retire');
  const partnerEl = document.getElementById('wi-partner-retire');

  const newYou = youEl ? parseInt(youEl.value, 10) : inp.retirementAge;
  const newPartner = partnerEl ? parseInt(partnerEl.value, 10) : inp.partnerRetirementAge;

  const testInp = { ...inp, retirementAge: newYou };
  if (inp.couple) testInp.partnerRetirementAge = newPartner;

  const testRes = project(testInp);
  const testW90 = testRes.totalsReal[testRes.totalsReal.length - 1] || 0;
  const testFull = testRes.milestones.fullAge;
  const baseFull = baseRes.milestones.fullAge;

  const diffW90 = testW90 - baseW90;
  const diffW90Str = Math.abs(diffW90) < 1000 ? 'No change' : (diffW90 > 0 ? `+${fmtK(diffW90)}` : `${fmtK(diffW90)}`);
  const diffW90Cls = Math.abs(diffW90) < 1000 ? 'wb-delta-nil' : (diffW90 > 0 ? 'wb-delta-good' : 'wb-delta-bad');

  let ageStr = testFull ?? '90+';
  let ageDeltaStr = '';
  if (baseFull != null && testFull != null) {
    const delta = testFull - baseFull;
    if (delta < 0) ageDeltaStr = `<span class="wb-delta-good">${Math.abs(delta)} yrs earlier</span>`;
    else if (delta > 0) ageDeltaStr = `<span class="wb-delta-bad">${delta} yrs later</span>`;
    else ageDeltaStr = `<span class="wb-delta-nil">No change</span>`;
  } else if (baseFull == null && testFull != null) {
    ageDeltaStr = `<span class="wb-delta-good">Now achievable!</span>`;
  } else if (baseFull != null && testFull == null) {
    ageDeltaStr = `<span class="wb-delta-bad">No longer reached</span>`;
  }

  document.getElementById('wi-global-result').innerHTML = `
    <div class="whatif-box">
      <div class="wb-label">Wealth at Age 90</div>
      <div class="wb-val ${diffW90Cls}">${diffW90Str}</div>
      <div class="wb-sub">vs base ${fmtK(baseW90)}</div>
    </div>
    <div class="whatif-box">
      <div class="wb-label">Your Full FIRE Age</div>
      <div class="wb-val">${ageStr}</div>
      <div class="wb-sub">${ageDeltaStr || 'Target reached'}</div>
    </div>
  `;
};

function renderOptimisations(inp, result) {
  const el = document.getElementById('opt-grid');
  if (!el) return;
  const opts = [];

  const baseW90 = result.totalsReal[result.totalsReal.length - 1] || 0;
  const baseTax = (result.rows[0]?.annualTax.total || 0) + (result.rows[0]?.invTax || 0);
  const baseFull = result.milestones.fullAge;

  const addOpt = (icon, title, desc, gain, cls = 'ready', valCls = 'sc-green') => {
    opts.push(`
      <div class="sc-card ${cls}">
        <div class="sc-head">
          <div class="sc-icon">${icon}</div>
          <div class="sc-titlewrap">
            <div class="sc-title">${title}</div>
            <div class="sc-sub" style="white-space:normal">${desc}</div>
          </div>
        </div>
        <div class="sc-body" style="margin-top:auto">
          <div class="sc-row"><span>Impact</span><span class="${valCls}">${gain}</span></div>
        </div>
      </div>
    `);
  };

  // 1. Work One More Year
  const oneMoreInp = { ...inp, retirementAge: inp.retirementAge + 1 };
  if (inp.couple) oneMoreInp.partnerRetirementAge = inp.partnerRetirementAge + 1;
  const oneMoreRes = project(oneMoreInp);
  const oneMoreW90 = oneMoreRes.totalsReal[oneMoreRes.totalsReal.length - 1] || 0;
  const diffW90 = oneMoreW90 - baseW90;
  if (diffW90 > 1000 && !result.failed) {
    addOpt('⏳', 'Work One More Year', 'Delay retirement by 1 year to let your portfolio compound and reduce the number of drawdown years.', `+${fmtK(diffW90)} wealth at 90`);
  } else if (oneMoreRes.depleteAge > (result.depleteAge || 0) || (!oneMoreRes.failed && result.failed)) {
    addOpt('⏳', 'Work One More Year', 'Delay retirement by 1 year to significantly improve portfolio survival.', `Delays shortfall`);
  }

  // 2. Max Concessional Super
  const p1SG = inp.grossSalary * inp.sgRate;
  const p1CapRoom = Math.max(0, CONCESSIONAL_CAP - p1SG - inp.extraConcessional);
  if (p1CapRoom > 1000 && inp.grossSalary > 45000) {
    const maxConcInp = { ...inp, extraConcessional: inp.extraConcessional + p1CapRoom };
    const maxConcRes = project(maxConcInp);
    const mcW90 = maxConcRes.totalsReal[maxConcRes.totalsReal.length - 1] || 0;
    const mcTax = (maxConcRes.rows[0]?.annualTax.total || 0) + (maxConcRes.rows[0]?.invTax || 0);
    const taxSaved = baseTax - mcTax;
    if (taxSaved > 0 && mcW90 > baseW90) {
      addOpt('📈', 'Max Salary Sacrifice', `Add ${fmt(p1CapRoom)}/yr to pre-tax super to hit the $30k concessional cap.`, `Save ${fmt(taxSaved)} tax this yr`);
    }
  }

  // 3. Tax-Smart Investments
  if (inp.couple && inp.investHolder !== 'lower' && (inp.investBalance > 0 || inp.cashBalance > 0 || inp.partnerInvestBalance > 0)) {
    const lowerInp = { ...inp, investHolder: 'lower' };
    const lowerRes = project(lowerInp);
    const lTax = (lowerRes.rows[0]?.annualTax.total || 0) + (lowerRes.rows[0]?.invTax || 0);
    const taxSaved = baseTax - lTax;
    if (taxSaved > 0) {
      addOpt('⚖️', 'Tax-Smart Investments', 'Switch taxable investments to the lower earner\'s name to reduce ongoing tax drag.', `Save ${fmt(taxSaved)} tax this yr`);
    }
  }

  // 4. Safer Withdrawal Rate
  if (inp.swr > 0.035) {
    const saferInp = { ...inp, swr: 0.035 };
    const saferRes = project(saferInp);
    const saferAge = saferRes.milestones.fullAge;
    if (saferAge) {
      const diff = saferAge - (baseFull || saferAge);
      const impactStr = diff > 0 ? `Retire ${diff} yr${diff !== 1 ? 's' : ''} later` : 'No delay in FIRE age';
      addOpt('🛡️', 'Conservative 3.5% SWR', `Lower withdrawal rate to 3.5% for more safety against sequence of returns risk.`, impactStr, 'gap', 'sc-red');
    }
  }

  if (opts.length === 0) {
    el.innerHTML = '<div class="joint-none" style="grid-column:1/-1">Your current setup is highly optimised! Try tweaking advanced assumptions.</div>';
  } else {
    el.innerHTML = opts.join('');
  }
}

// ══════════════════════════════════════════════════════════
//  SCENARIO ANALYSIS
// ══════════════════════════════════════════════════════════

function renderScenarios(inp, p1Res, p2Res) {
  const el = document.getElementById('scenario-grid');
  const introEl = document.getElementById('scenario-intro');
  if (!el) return;
  if (!p1Res || !p2Res) {
    el.innerHTML = '';
    if (introEl) introEl.textContent = 'Simulate different decisions (like retiring immediately or coasting) to see if the portfolio survives to age 90.';
    return;
  }
  if (introEl) introEl.textContent = 'Each card shows one sequential retirement scenario: one partner retires while the other keeps working, so only the retiring partner needs to fund the household expense gap (not the full FI number).';

  const p1Sac = Math.min(inp.extraConcessional, Math.max(0, CONCESSIONAL_CAP - inp.grossSalary * inp.sgRate));
  const p2Sac = Math.min(inp.partnerExtraConcessional, Math.max(0, CONCESSIONAL_CAP - inp.partnerSalary * inp.sgRate));
  const p1Net = calcTax(inp.grossSalary, p1Sac, inp.hecsActive, taxOpts(inp)).net;
  const p2Net = calcTax(inp.partnerSalary, p2Sac, inp.partnerHecsActive, taxOpts(inp)).net;

  // Effective full expenses at each relevant age (houseBuyAge is on primary's age axis)
  const p2RetireInPrimaryAge = inp.currentAge + (inp.partnerRetirementAge - inp.partnerAge);
  const effExpNow      = houseExpAdjAt(inp, inp.currentAge);      // SC1/SC2: today
  const effExpP1Retire = houseExpAdjAt(inp, inp.retirementAge);   // SC3: your retirement age
  const effExpP2Retire = houseExpAdjAt(inp, p2RetireInPrimaryAge);// SC4: partner retirement (primary's age)

  // Sequential FI: portfolio needed by the retiring person while the other keeps working
  // SC1: partner retires now — expenses are today's; SC3/SC4: expenses at target retirement age
  const seqIfPartnerRetiresNow    = Math.max(0, effExpNow      - p1Net) / inp.swr;
  const seqIfYouRetireNow         = Math.max(0, effExpNow      - p2Net) / inp.swr;
  const seqIfYouRetireAtTarget    = Math.max(0, effExpP1Retire - p2Net) / inp.swr;
  const seqIfPartnerRetiresTarget = Math.max(0, effExpP2Retire - p1Net) / inp.swr;

  // SC1/SC2 use "now" figures; SC3/SC4 use target-age figures
  const seqIfPartnerRetires = seqIfPartnerRetiresNow;
  const seqIfYouRetire      = seqIfYouRetireNow;

  // Current accessible wealth (super locked pre-60)
  const p1Accessible = (inp.currentAge >= PRESERVATION_AGE ? inp.superBalance : 0)
    + inp.investBalance + inp.cashBalance;
  const p2Accessible = (inp.partnerAge >= PRESERVATION_AGE ? inp.partnerSuperBalance : 0)
    + (inp.partnerInvestBalance || 0) + (inp.partnerCashBalance || 0);

  const findAge = (rows, target, startAge) => {
    if (target <= 0) return startAge;
    const r = rows.find(row => {
      const w = row.age >= PRESERVATION_AGE ? row.totalReal : row.accessibleReal;
      return w >= target;
    });
    return r ? r.age : null;
  };

  const partnerSeqAge = findAge(p2Res.rows, seqIfPartnerRetires, inp.partnerAge);
  const youSeqAge     = findAge(p1Res.rows, seqIfYouRetire,      inp.currentAge);

  const p1AtTarget = p1Res.rows.find(r => r.age === inp.retirementAge);
  const p2AtTarget = p2Res.rows.find(r => r.age === inp.partnerRetirementAge);

  const getW = (row, age) => row
    ? (age >= PRESERVATION_AGE ? row.totalReal : row.accessibleReal) : null;

  const p1WealthAtTarget = getW(p1AtTarget, inp.retirementAge);
  const p2WealthAtTarget = getW(p2AtTarget, inp.partnerRetirementAge);

  const CY = new Date().getFullYear();
  const youRetireInCY     = CY + (inp.retirementAge - inp.currentAge);
  const partnerRetireInCY = CY + (inp.partnerRetirementAge - inp.partnerAge);
  const overlapYrs        = partnerRetireInCY - youRetireInCY;

  const badge  = (have, need) => (need <= 0 || have >= need) ? 'ready' : 'gap';
  const blabel = (have, need) => {
    if (need <= 0) return '✓ Ready now';
    if (have >= need) return '✓ On track';
    return Math.round(have / need * 100) + '% funded';
  };

  const scCard2 = (icon, title, sub, have, need, rows, footer) => `
    <div class="sc-card ${badge(have, need)}">
      <div class="sc-head">
        <div class="sc-icon">${icon}</div>
        <div class="sc-titlewrap">
          <div class="sc-title">${title}</div>
          <div class="sc-sub">${sub}</div>
        </div>
        <div class="sc-badge sc-badge-${badge(have, need)}">${blabel(have, need)}</div>
      </div>
      <div class="sc-body">
        ${rows.map(([l, v, cls]) =>
          `<div class="sc-row${cls ? ' ' + cls : ''}"><span>${l}</span><span>${v}</span></div>`
        ).join('')}
      </div>
      ${footer ? `<div class="sc-foot">${footer}</div>` : ''}
    </div>`;

  // ── SC1: Partner retires NOW, you keep working ──
  const sc1Gap = Math.max(0, effExpNow - p1Net);
  const sc1Rows = seqIfPartnerRetires <= 0
    ? [['Your net salary covers full household expenses', '🎉 Zero portfolio needed!', 'sc-green']]
    : [
        [`Household expenses (${fmt(effExpNow)}/yr) minus your salary`, fmt(sc1Gap) + '/yr gap', ''],
        ['Partner needs (gap ÷ SWR) — household gap only', fmtK(seqIfPartnerRetires), ''],
        ['Partner accessible wealth today', fmtK(p2Accessible), ''],
        p2Accessible >= seqIfPartnerRetires
          ? ['Surplus', fmtK(p2Accessible - seqIfPartnerRetires), 'sc-green']
          : ['Shortfall remaining', fmtK(seqIfPartnerRetires - p2Accessible), 'sc-red'],
      ];
  const sc1Footer = seqIfPartnerRetires <= 0
    ? `Your salary (${fmt(p1Net)}/yr net) already covers the full ${fmt(effExpNow)} household total — partner needs zero portfolio to retire now.`
    : p2Accessible >= seqIfPartnerRetires
    ? `Partner can retire RIGHT NOW with ${fmtK(p2Accessible - seqIfPartnerRetires)} to spare. You keep working until age ${inp.retirementAge}.`
    : `Partner reaches this target at age <strong>${partnerSeqAge ?? '90+'}</strong>${partnerSeqAge ? ` (${partnerSeqAge - inp.partnerAge} yrs away)` : ''}.`;

  // ── SC2: You retire NOW, partner keeps working ──
  const sc2Gap = Math.max(0, effExpNow - p2Net);
  const sc2Rows = seqIfYouRetire <= 0
    ? [['Partner net salary covers full household expenses', '🎉 Zero portfolio needed!', 'sc-green']]
    : [
        [`Household expenses (${fmt(effExpNow)}/yr) minus partner salary`, fmt(sc2Gap) + '/yr gap', ''],
        ['You need (gap ÷ SWR) — household gap only', fmtK(seqIfYouRetire), ''],
        ['Your accessible wealth today', fmtK(p1Accessible), ''],
        p1Accessible >= seqIfYouRetire
          ? ['Surplus', fmtK(p1Accessible - seqIfYouRetire), 'sc-green']
          : ['Shortfall remaining', fmtK(seqIfYouRetire - p1Accessible), 'sc-red'],
      ];
  const sc2Footer = seqIfYouRetire <= 0
    ? `Partner's salary (${fmt(p2Net)}/yr net) covers the full ${fmt(effExpNow)} household total — you need zero portfolio to retire now.`
    : p1Accessible >= seqIfYouRetire
    ? `You can retire RIGHT NOW with ${fmtK(p1Accessible - seqIfYouRetire)} to spare. Partner keeps working until age ${inp.partnerRetirementAge}.`
    : `You reach this target at age <strong>${youSeqAge ?? '90+'}</strong>${youSeqAge ? ` (${youSeqAge - inp.currentAge} yrs away)` : ''}.`;

  // ── SC3: You retire at your target age, partner works to theirs ──
  const sc3Need = seqIfYouRetireAtTarget;
  const sc3Rows = sc3Need <= 0
    ? [['Partner salary covers full household expenses', '🎉 No portfolio needed', 'sc-green']]
    : [
        [`Household expenses at age ${inp.retirementAge} (${fmt(effExpP1Retire)}/yr) minus partner salary`, fmtK(sc3Need) + ' gap', ''],
        ['Your projected individual wealth at that age', p1WealthAtTarget != null ? fmtK(p1WealthAtTarget) : '—', ''],
        p1WealthAtTarget == null ? ['Projection unavailable', '—', '']
          : p1WealthAtTarget >= sc3Need
          ? ['Surplus at target retirement', fmtK(p1WealthAtTarget - sc3Need), 'sc-green']
          : ['Shortfall at target retirement', fmtK(sc3Need - p1WealthAtTarget), 'sc-red'],
      ];
  const sc3Footer = sc3Need <= 0
    ? `Partner's salary covers full household expenses during your retirement until they also stop at ${inp.partnerRetirementAge}.`
    : p1WealthAtTarget == null ? 'No projection data for that retirement age.'
    : p1WealthAtTarget >= sc3Need
    ? `On track.${overlapYrs > 0 ? ` Partner works ${overlapYrs} more yr${overlapYrs !== 1 ? 's' : ''} after you retire, covering household costs.` : ''}${inp.retirementAge < 60 ? ' ⚠ Super locked until 60 — bridge from investments.' : ''}`
    : `${fmtK(sc3Need - p1WealthAtTarget)} short at age ${inp.retirementAge}. ${inp.retirementAge < 60 ? '⚠ Super locked until 60.' : 'Consider increasing contributions or adjusting target age.'}`;

  // ── SC4: Partner retires at their target, you work to yours ──
  const sc4Need = seqIfPartnerRetiresTarget;
  const sc4Rows = sc4Need <= 0
    ? [['Your salary covers full household expenses', '🎉 No portfolio needed', 'sc-green']]
    : [
        [`Household expenses at partner age ${inp.partnerRetirementAge} (${fmt(effExpP2Retire)}/yr) minus your salary`, fmtK(sc4Need) + ' gap', ''],
        ['Partner projected individual wealth at that age', p2WealthAtTarget != null ? fmtK(p2WealthAtTarget) : '—', ''],
        p2WealthAtTarget == null ? ['Projection unavailable', '—', '']
          : p2WealthAtTarget >= sc4Need
          ? ['Surplus at target retirement', fmtK(p2WealthAtTarget - sc4Need), 'sc-green']
          : ['Shortfall at target retirement', fmtK(sc4Need - p2WealthAtTarget), 'sc-red'],
      ];
  const sc4Footer = sc4Need <= 0
    ? `Your salary covers the full household total while partner retires — they can stop immediately.`
    : p2WealthAtTarget == null ? 'No projection data for that retirement age.'
    : p2WealthAtTarget >= sc4Need
    ? `Partner on track.${overlapYrs < 0 ? ` You work ${-overlapYrs} more yr${-overlapYrs !== 1 ? 's' : ''} after partner retires, covering household costs.` : ''}${inp.partnerRetirementAge < 60 ? ' ⚠ Partner super locked until 60 — bridge from investments.' : ''}`
    : `Partner ${fmtK(sc4Need - p2WealthAtTarget)} short at age ${inp.partnerRetirementAge}. ${inp.partnerRetirementAge < 60 ? '⚠ Partner super locked until 60.' : 'Consider higher partner contributions or later target.'}`;

  el.innerHTML =
    scCard2('👫', 'Partner retires now', 'You keep working to age ' + inp.retirementAge, p2Accessible, seqIfPartnerRetires, sc1Rows, sc1Footer) +
    scCard2('🧑', 'You retire now', 'Partner keeps working to age ' + inp.partnerRetirementAge, p1Accessible, seqIfYouRetire, sc2Rows, sc2Footer) +
    scCard2('🎯', 'You retire at ' + inp.retirementAge, 'Partner works to ' + inp.partnerRetirementAge, p1WealthAtTarget ?? 0, sc3Need, sc3Rows, sc3Footer) +
    scCard2('🎯', 'Partner retires at ' + inp.partnerRetirementAge, 'You work to ' + inp.retirementAge, p2WealthAtTarget ?? 0, sc4Need, sc4Rows, sc4Footer);
}

// ══════════════════════════════════════════════════════════
//  YEAR-BY-YEAR TABLE
// ══════════════════════════════════════════════════════════

function renderYearTable(rows, couple) {
  const el = document.getElementById('year-table');
  if (!el) return;
  const f = n => n > 0.5 ? fmt(n) : '—';
  const body = rows.map(r => {
    // During retirement with a working partner, householdNet is partner-only salary
    const basePhase = r.retired
      ? (r.householdNet > 0 ? '🏖+💼 Partner working' : '🏖 Both retired')
      : '💼 Working';
    const houseTag = r.houseExpAdj != null && r.houseExpAdj !== 0
      ? (r.houseExpAdj > 0 ? ' · 🏠 mortgage' : ' · 🏠 owned') : '';
    const phase = basePhase + houseTag;
    const netIncome = f(r.annualTax.net ?? r.householdNet);
    return `
    <tr${r.retired ? ' class="yt-ret"' : ''}>
      <td class="yt-l">${r.age}</td>
      <td class="yt-l">${phase}</td>
      <td>${netIncome}</td>
      <td>${f((r.annualTax.total ?? 0) + (r.invTax ?? 0))}</td>
      <td>${f(r.annualSavings)}</td>
      <td>${f(r.netSuperContrib)}</td>
      <td>${f(r.pension)}</td>
      <td>${f(r.supDraw + r.invDraw + r.cashDraw)}</td>
      <td>${fmtK(r.supReal)}</td>
      <td>${fmtK(r.invReal)}</td>
      <td>${fmtK(r.cashReal)}</td>
      <td><strong>${fmtK(r.totalReal)}</strong></td>
    </tr>`;
  }).join('');

  const netIncomeHeader = couple ? 'Household Net Income' : 'Net Income';
  const ageHeader = couple ? 'Your Age' : 'Age';
  const yearTableNote = document.getElementById('year-table-note');
  if (yearTableNote) yearTableNote.textContent = couple
    ? "all values in today's dollars · age column is your age"
    : "all values in today's dollars";
  el.innerHTML = `
    <table class="year-table">
      <thead><tr>
        <th class="yt-l">${ageHeader}</th><th class="yt-l">Phase</th><th>${netIncomeHeader}</th><th>Tax</th>
        <th>Saved</th><th>→ Super</th><th>Pension</th><th>Drawdown</th>
        <th>Super</th><th>Invest</th><th>Cash</th><th>Total</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

// ══════════════════════════════════════════════════════════
//  MAIN CALCULATE
// ══════════════════════════════════════════════════════════

let debounceTimer;
let _lastRows = [];
let _lastInp   = null; // snapshot of last parsed inputs, used by the what-if slider

function calc() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(_calc, 80);
}

function _calc() {
  const inp = getInputs();

  if (inp.retirementAge <= inp.currentAge) {
    document.getElementById('retirementAge').value = inp.currentAge + 1;
    inp.retirementAge = inp.currentAge + 1;
  }
  if (inp.couple && inp.partnerRetirementAge <= inp.partnerAge) {
    const el = document.getElementById('partnerRetirementAge');
    if (el) { el.value = inp.partnerAge + 1; inp.partnerRetirementAge = inp.partnerAge + 1; }
  }

  updateCoupleUI(inp.couple);

  // Mortgage repayment hint
  const mortgageHint = document.getElementById('mortgage-repayment-hint');
  if (mortgageHint) {
    const repay = annualMortgageRepayment(inp.mortgageAmount, inp.mortgageRate, inp.mortgageTerm);
    const active = inp.houseDeposit > 0 || inp.mortgageAmount > 0;
    if (active && repay > 0) {
      const paidAge = inp.houseBuyAge + inp.mortgageTerm;
      mortgageHint.textContent = `Annual repayment: ${fmt(repay)}/yr (${fmt(repay / 12)}/mo) · mortgage-free at age ${paidAge}`;
      mortgageHint.style.display = 'block';
    } else {
      mortgageHint.style.display = 'none';
    }
  }

  _lastInp = inp;

  const p1SG    = inp.grossSalary * inp.sgRate;
  const capRoom = Math.max(0, CONCESSIONAL_CAP - p1SG);
  document.getElementById('cap-warning').classList.toggle('show', inp.extraConcessional > capRoom + inp.carryForwardCap);
  const pCapW = document.getElementById('p-cap-warning');
  if (pCapW) pCapW.classList.toggle('show',
    inp.couple && inp.partnerExtraConcessional > Math.max(0, CONCESSIONAL_CAP - inp.partnerSalary * inp.sgRate) + inp.partnerCarryForwardCap);

  const p1SacNow = Math.min(inp.extraConcessional, capRoom + inp.carryForwardCap);
  const p2SacNow = Math.min(inp.partnerExtraConcessional, Math.max(0, CONCESSIONAL_CAP - inp.partnerSalary * inp.sgRate) + inp.partnerCarryForwardCap);
  const p1NetNow = calcTax(inp.grossSalary, p1SacNow, inp.hecsActive, taxOpts(inp)).net;
  const p2NetNow = calcTax(inp.partnerSalary, p2SacNow, inp.partnerHecsActive, taxOpts(inp)).net;

  const result             = project(inp);
  const mc                 = runMonteCarlo(inp);
  const partnerResult      = inp.couple ? projectPartner(inp, p1NetNow) : null;
  const primaryResult      = inp.couple ? projectPrimary(inp, p2NetNow) : null;
  _lastRows = result.rows;

  window._lastAuditLog = [
    '🔥 FIRE Calculator Audit Logs (Calculations & Output)',
    '1. Parsed Inputs:\n' + JSON.stringify(inp, null, 2),
    '2. Base Projection Result:\n' + JSON.stringify(result, null, 2),
    '3. Monte Carlo Result:\n' + JSON.stringify(mc, null, 2),
    inp.couple ? '4. Partner Projection Result:\n' + JSON.stringify(partnerResult, null, 2) : '',
    inp.couple ? '5. Primary Individual Projection Result:\n' + JSON.stringify(primaryResult, null, 2) : ''
  ].filter(Boolean).join('\n\n');

  // Print structured audit logs to the console for testing and validation
  console.groupCollapsed('🔥 FIRE Calculator Audit Logs (Calculations & Output)');
  console.log(window._lastAuditLog);
  console.groupEnd();

  const { rows, milestones, targets, bridgeAtRetirement, currentSavings } = result;

  renderHero(inp, result, mc, buildWarnings(inp, result));

  const currentTotal = inp.superBalance + inp.partnerSuperBalance + inp.investBalance + inp.cashBalance
    + inp.partnerInvestBalance + inp.partnerCashBalance;
    
  const p1CanToday = inp.currentAge >= PRESERVATION_AGE;
  const p2CanToday = inp.couple && inp.partnerAge >= PRESERVATION_AGE;
  const currentAccessible = (p1CanToday ? inp.superBalance : 0) + 
    (p2CanToday ? inp.partnerSuperBalance : 0) + 
    inp.investBalance + inp.cashBalance + 
    inp.partnerInvestBalance + inp.partnerCashBalance;

  const getCardData = (mAge, targetKey, fallbackTarget, expBase) => {
    const age = mAge != null ? mAge : inp.retirementAge;
    const row = rows.find(r => r.age === age);
    const targetVal = row ? row[targetKey] : fallbackTarget;
    const houseAdj = row ? (row.houseExpAdj ?? 0) : (rows.find(r => r.age === inp.retirementAge)?.houseExpAdj ?? 0);
    const effExp = Math.max(0, expBase + houseAdj);
    const nomExp = effExp * Math.pow(1 + inp.inflation, Math.max(0, age - inp.currentAge));
    const progress = targetVal > 0 ? ((age >= PRESERVATION_AGE ? currentTotal : currentAccessible) / targetVal) * 100 : 100;
    return { age, targetVal, effExp, nomExp, progress, houseAdj };
  };

  const getSuperNote = (age) => age < PRESERVATION_AGE
    ? `⚠ Super locked until 60 · bridge from investments`
    : (age < UNRESTRICTED_AGE
        ? `Super accessible at 60 (condition of release) · unrestricted at 65`
        : `Super accessible unconditionally from age 65`);

  const houseExpNoteFn = (adj) => adj !== 0
    ? ` <span style="font-size:10px;color:var(--text-muted)">(${adj > 0 ? '+mortgage −rent' : '−rent, no mortgage'})</span>` : '';

  const coastRow = rows.find(r => r.age === inp.currentAge);
  const currentCoastTgt = coastRow ? coastRow.coastNow : coastTarget(targets.fiEff, inp.retirementAge - inp.currentAge,
    (1 + inp.investReturn) / (1 + inp.inflation) - 1);
  const currentCoastCheckW = inp.retirementAge >= PRESERVATION_AGE ? currentTotal : currentAccessible;

  const hhTagText = inp.couple ? 'household total' : 'your total';
  const hhTag = `<span style="font-size:10px;font-weight:600;color:var(--coast);background:rgba(37,99,235,0.08);border-radius:3px;padding:1px 4px;margin-left:3px">${hhTagText}</span>`;

  const cDesc = inp.couple ? 'combined wealth coasts' : 'wealth coasts';
  const hwDesc = inp.couple ? 'Household' : 'You';

  // ── PRIMARY MILESTONE CARDS ──
  const leanD = getCardData(milestones.leanAge, 'leanTgt', targets.leanFIEff, inp.leanExpenses);
  renderCard('lean', milestones.leanAge, inp.currentAge, leanD.targetVal,
    `${hwDesc} spend${inp.couple ? 's' : ''} ${fmt(leanD.effExp)}/yr${houseExpNoteFn(leanD.houseAdj)} ${hhTag} &bull; ${(1 / inp.swr).toFixed(0)}&times; expenses<br>
     <span style="font-size:10px;color:var(--text-muted)">${getSuperNote(leanD.age)}</span>`,
    leanD.progress);

  renderCard('coast', milestones.coastAge, inp.currentAge, currentCoastTgt,
    `Stop ALL extra contributions &mdash; ${cDesc} to ${fmtK(targets.fiEff)} ${hhTag} by age ${inp.retirementAge}<br>
     <span style="font-size:10px;color:var(--text-muted)">${inp.retirementAge >= PRESERVATION_AGE ? 'Uses total wealth incl. super (still employed during coast)' : 'Liquid assets must bridge to age 60 &mdash; super compounds untouched'}</span>`,
    currentCoastCheckW / currentCoastTgt * 100);

  const baristaD = getCardData(milestones.baristaAge, 'baristaTgt', targets.baristaFI, inp.baristaExpenses);
  renderCard('barista', milestones.baristaAge, inp.currentAge, baristaD.targetVal,
    `Part-time ${fmt(inp.baristaIncome)}/yr until ${inp.baristaStopAge} &bull; ${hwDesc.toLowerCase()} need${inp.couple ? 's' : ''} ${fmt(baristaD.effExp)}/yr${houseExpNoteFn(baristaD.houseAdj)} ${hhTag}<br>
     <span style="font-size:10px;color:var(--text-muted)">Target shrinks as part-time years shorten · ${getSuperNote(baristaD.age)}</span>`,
    baristaD.progress);

  const fullD = getCardData(milestones.fullAge, 'fullTgt', targets.fiEff, inp.fullExpenses);
  renderCard('full', milestones.fullAge, inp.currentAge, fullD.targetVal,
    `${hwDesc} spend${inp.couple ? 's' : ''} ${fmt(fullD.effExp)}/yr${houseExpNoteFn(fullD.houseAdj)} ${hhTag} &rarr; ${fmt(fullD.nomExp)}/yr at ${fullD.age} (with inflation)<br>
     <span style="font-size:10px;color:var(--text-muted)">${getSuperNote(fullD.age)}</span>`,
    fullD.progress);

  // ── PARTNER MILESTONE CARDS ──
  if (inp.couple && partnerResult) {
    const { milestones: pm, targets: pt, rows: pRows } = partnerResult;

    const pTotal    = inp.partnerSuperBalance + inp.partnerInvestBalance + inp.partnerCashBalance;
    const pAccessible = (p2CanToday ? inp.partnerSuperBalance : 0) + inp.partnerInvestBalance + inp.partnerCashBalance;

    const getPartnerCardData = (mAge, targetKey, fallbackTarget, expBase) => {
      const age = mAge != null ? mAge : inp.partnerRetirementAge;
      const row = pRows.find(r => r.age === age);
      const targetVal = row ? row[targetKey] : fallbackTarget;
      
      const primaryAgeAtThisTime = inp.currentAge + (age - inp.partnerAge);
      const mainRow = rows.find(r => r.age === primaryAgeAtThisTime);
      const houseAdj = mainRow ? (mainRow.houseExpAdj ?? 0) : 0;
      
      const effExp = Math.max(0, expBase + houseAdj);
      const gap = Math.max(0, effExp - p1NetNow);
      const progress = targetVal > 0 ? ((age >= PRESERVATION_AGE ? pTotal : pAccessible) / targetVal) * 100 : 100;
      return { age, targetVal, gap, progress, houseAdj };
    };

    const pSuperNoteFn = (age) => age < PRESERVATION_AGE
      ? `⚠ Partner super locked until 60 · bridge from investments`
      : (age < UNRESTRICTED_AGE
          ? `Super accessible at 60 (condition of release) · unrestricted at 65`
          : `Super accessible unconditionally from age 65`);

    const pCoastTgt = coastTarget(pt.fiEff, inp.partnerRetirementAge - inp.partnerAge,
      (1 + inp.investReturn) / (1 + inp.inflation) - 1);
    const pCoastProgress = pCoastTgt > 0 ? (pTotal / pCoastTgt) * 100 : 100;

    const pNoteFn = (age) => `<span style="font-size:10px;color:var(--text-muted)">Partner's individual wealth covering the gap while you work · ${pSuperNoteFn(age)}</span>`;

    const pLeanD = getPartnerCardData(pm.leanAge, 'leanTgt', pt.leanFIEff, inp.leanExpenses);
    renderCard('p-lean', pm.leanAge, inp.partnerAge, pLeanD.targetVal,
      `Household lean spend ${fmt(pLeanD.gap + p1NetNow)}/yr${houseExpNoteFn(pLeanD.houseAdj)} minus your net salary (${fmt(p1NetNow)}/yr) = ${fmt(pLeanD.gap)}/yr gap<br>
       ${pNoteFn(pLeanD.age)}`,
      pLeanD.progress);

    renderCard('p-coast', pm.coastAge, inp.partnerAge, pCoastTgt,
      `Partner's wealth coasts to the ${fmtK(pt.fiEff)} sequential gap target by ${inp.partnerRetirementAge}<br>
       <span style="font-size:10px;color:var(--text-muted)">Partner's super + partner's own investments</span>`,
      pCoastProgress);

    const pBaristaD = getPartnerCardData(pm.baristaAge, 'baristaTgt', pt.baristaFI, inp.baristaExpenses);
    renderCard('p-barista', pm.baristaAge, inp.partnerAge, pBaristaD.targetVal,
      `Household barista gap ${fmt(pBaristaD.gap)}/yr${houseExpNoteFn(pBaristaD.houseAdj)} minus partner's ${fmt(inp.baristaIncome)}/yr part-time income<br>
       ${pNoteFn(pBaristaD.age)}`,
      pBaristaD.progress);

    const pFullD = getPartnerCardData(pm.fullAge, 'fullTgt', pt.fiEff, inp.fullExpenses);
    renderCard('p-full', pm.fullAge, inp.partnerAge, pFullD.targetVal,
      `Household full spend ${fmt(pFullD.gap + p1NetNow)}/yr${houseExpNoteFn(pFullD.houseAdj)} minus your net salary (${fmt(p1NetNow)}/yr) = ${fmt(pFullD.gap)}/yr gap<br>
       ${pNoteFn(pFullD.age)}`,
      pFullD.progress);

    renderJointSummary(inp, milestones, pm);
  }

  renderScenarios(inp, primaryResult ?? result, partnerResult);
  renderWhatIf(inp, result);
  renderOptimisations(inp, result);

  // ── TAX STRIP (primary earner only) ──
  const p1Sacrifice = Math.min(inp.extraConcessional, capRoom);
  const p1TaxNow    = calcTax(inp.grossSalary, p1Sacrifice, inp.hecsActive, taxOpts(inp));
  const p1TaxTotal  = (p1TaxNow.raw || 0) + (p1TaxNow.hecs || 0);
  const savingsRate = inp.grossSalary > 0 ? currentSavings / inp.grossSalary * 100 : 0;

  const taxStripNote = document.getElementById('tax-strip-note');
  if (taxStripNote) taxStripNote.textContent = inp.couple ? 'your figures only — not partner' : 'your figures';
  const taxChartSub = document.getElementById('tax-chart-sub');
  if (taxChartSub) taxChartSub.textContent = inp.couple ? "Where your gross salary goes — your figures only, not your partner's" : 'Where your gross salary goes';

  document.getElementById('ts-gross').textContent   = fmt(inp.grossSalary);
  document.getElementById('ts-tax').textContent     = fmt(p1TaxTotal);
  document.getElementById('ts-taxrate').textContent = pct(p1TaxTotal / Math.max(1, inp.grossSalary)) + ' eff.';
  document.getElementById('ts-take').textContent    = fmt(p1TaxNow.net || 0);
  document.getElementById('ts-weekly').textContent  = fmt(Math.round((p1TaxNow.net || 0) / 52)) + '/wk';
  document.getElementById('ts-sg').textContent      = fmt(p1SG + p1Sacrifice);
  document.getElementById('ts-cap').textContent     = fmt(Math.max(0, CONCESSIONAL_CAP - p1SG - p1Sacrifice));
  document.getElementById('ts-save').textContent    = fmt(currentSavings);
  document.getElementById('ts-saverate').textContent = savingsRate.toFixed(0) + '% savings rate';

  // ── POSITION CARDS ──
  const totalSuper  = inp.superBalance + inp.partnerSuperBalance;
  const totalInvest = inp.investBalance + inp.cashBalance + inp.partnerInvestBalance + inp.partnerCashBalance;
  const superLbl  = document.getElementById('pos-super-label');
  const investLbl = document.getElementById('pos-invest-label');
  const totalLbl  = document.getElementById('pos-total-label');
  if (superLbl)  superLbl.textContent  = inp.couple ? 'Super (combined)' : 'Super';
  if (investLbl) investLbl.textContent = inp.couple ? 'Investments & Cash (combined)' : 'Investments & Cash';
  if (totalLbl)  totalLbl.textContent  = inp.couple ? 'Total Household Wealth' : 'Total Wealth';
  document.getElementById('pos-super').textContent  = fmtK(totalSuper);
  document.getElementById('pos-invest').textContent = fmtK(totalInvest);
  document.getElementById('pos-total').textContent  = fmtK(totalSuper + totalInvest);

  // ── CHARTS & TABLE ──
  buildProjectionChart(rows, milestones, targets, inp, mc);
  buildTimelineChart(milestones, inp.currentAge,
    partnerResult?.milestones ?? null, inp.couple ? inp.partnerAge : null);
  buildIncomeChart(inp, result);
  buildTaxChart(p1TaxNow, inp.grossSalary, p1SG);
  buildSavingsChart(rows, inp.retirementAge, inp.partnerRetirementAge, inp);
  renderYearTable(rows, inp.couple);

  saveState();
}

// ══════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════

function initRanges() {
  document.querySelectorAll('input[type="range"]').forEach(el => {
    const min = parseFloat(el.min), max = parseFloat(el.max), v = parseFloat(el.value);
    el.style.setProperty('--val', ((v - min) / (max - min) * 100).toFixed(1) + '%');
  });
}

function initUX() {
  // Auto-select number inputs on focus so users can easily overwrite values
  document.querySelectorAll('input[type="number"]').forEach(el => {
    el.addEventListener('focus', function() { this.select(); });
  });
}

document.getElementById('currentAge').addEventListener('input', function () {
  const v   = parseInt(this.value, 10);
  const ret = document.getElementById('retirementAge');
  ret.min = v + 1;
  if (parseInt(ret.value, 10) <= v) {
    ret.value = v + 5;
    document.getElementById('lbl-retire').textContent = v + 5;
  }
});

document.getElementById('partnerAge')?.addEventListener('input', function () {
  const v   = parseInt(this.value, 10);
  const ret = document.getElementById('partnerRetirementAge');
  if (!ret) return;
  ret.min = v + 1;
  if (parseInt(ret.value, 10) <= v) {
    ret.value = v + 5;
    document.getElementById('lbl-partner-retire').textContent = v + 5;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initDark();
  // A shared link's parameters beat locally saved state
  if (!applyUrlParams()) loadState();
  initRanges();
  initUX();
  updateRangeLabels();
  updateCoupleUI(document.getElementById('status').value === 'couple');
  updateConditionalUI();
  calc();
});
