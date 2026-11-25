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

const MEDICARE_THRESHOLD        = 28011; // single low-income threshold (FY 2025-26)
const MEDICARE_THRESHOLD_SENIOR = 43020; // SAPTO-eligible senior single threshold (FY 2025-26)
function medicareLevy(income, isSenior = false) {
  const thresh = isSenior ? MEDICARE_THRESHOLD_SENIOR : MEDICARE_THRESHOLD;
  if (income <= thresh) return 0;
  return Math.min(income * 0.02, (income - thresh) * 0.10);
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

// Seniors and Pensioners Tax Offset (SAPTO) — FY 2025-26
function sapto(income, couple = false) {
  const maxOffset = couple ? 1602 : 2230;
  const threshold = couple ? 28974 : 32279;
  if (income <= threshold) return maxOffset;
  return Math.max(0, maxOffset - (income - threshold) * 0.125);
}

// HELP repayments — 2025-26 marginal system (switches to 10% flat above $179,285)
function hecsRepayment(repayIncome) {
  if (repayIncome <= 67000)  return 0;
  if (repayIncome <= 125000) return (repayIncome - 67000) * 0.15;
  if (repayIncome <= 179285) return 8700 + (repayIncome - 125000) * 0.17;
  return repayIncome * 0.10;
}

function div293Tax(taxableIncome, concessional) {
  const combined = taxableIncome + concessional;
  if (combined <= 250000) return 0;
  return Math.min(combined - 250000, concessional) * 0.15;
}

// Marginal cost of extra assessable income (e.g. investment distributions)
// stacked on top of a person's existing taxable income
const taxPlusMedicare = (t, isSenior = false, couple = false) => {
  const offset = lito(t) + (isSenior ? sapto(t, couple) : 0);
  return Math.max(0, incomeTax(t) - offset) + medicareLevy(t, isSenior);
};
const taxOnExtraIncome = (base, extra, isSenior = false, couple = false) =>
  extra <= 0 ? 0 : taxPlusMedicare(base + extra, isSenior, couple) - taxPlusMedicare(base, isSenior, couple);

function calcTax(grossSalary, salarySacrifice, hasHECS, opts = {}) {
  const gross     = Math.max(0, grossSalary || 0);
  const sac       = Math.max(0, Math.min(salarySacrifice || 0, gross));
  const taxable   = Math.max(0, gross - sac);
  const mlsIncome = taxable + sac; // income for MLS/HELP incl. reportable super
  const isSen     = !!opts.isSenior;
  const offset    = lito(taxable) + (isSen ? sapto(taxable, !!opts.family) : 0);
  const base      = Math.max(0, incomeTax(taxable) - offset); // LITO & SAPTO offset income tax only
  const medicare  = medicareLevy(taxable, isSen);
  const mls       = opts.noPHI ? mlsAmount(mlsIncome, opts.mlsCombined ?? mlsIncome, !!opts.family) : 0;
  const raw       = base + medicare + mls;
  // HELP repayment income includes reportable super — sacrifice doesn't reduce it
  const hecs      = hasHECS ? hecsRepayment(mlsIncome) : 0;
  const total     = raw + hecs;
  return { taxable, sac, raw, medicare, mls, hecs, total, net: Math.max(0, gross - sac - total) };
}

// ══════════════════════════════════════════════════════════
//  SUPERANNUATION & AGE PENSION
// ══════════════════════════════════════════════════════════

const CONCESSIONAL_CAP      = 30000;
const NON_CONCESSIONAL_CAP  = 120000;
const MAX_SG_BASE           = 250000; // FY 2025-26 Maximum Super Contribution Base ($62,500/qtr)
const CARRY_FWD_TSB_LIMIT   = 500000; // Total super balance must be < $500k to use carry-forward
const PRESERVATION_AGE      = 60;
const UNRESTRICTED_AGE      = 65;
const AGE_PENSION_AGE       = 67;
const TRANSFER_BALANCE_CAP  = 2000000;
const NCC_TSB_LIMIT         = TRANSFER_BALANCE_CAP;

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
// For a couple with only one member of pension age, half the couple rate
// and half the combined taper rates apply, tested on combined means.
function agePensionEstimate(assessableAssets, homeowner, couple, opts = {}) {
  const bothEligible = opts.bothEligible !== false;
  const scale = (couple && !bothEligible) ? 0.5 : 1;
  const maxRate = (couple ? PENSION_COUPLE : PENSION_SINGLE) * scale;
  const fullThresh = (couple ? 481500 : 321500) + (homeowner ? 0 : 258000);
  const assetTest = Math.max(0, maxRate -
    Math.max(0, Math.floor((assessableAssets - fullThresh) / 1000)) * 3 * 26 * scale);
  const dt = couple ? DEEM_THRESH_COUPLE : DEEM_THRESH_SINGLE;
  const deemed = Math.min(assessableAssets, dt) * DEEM_LOW +
    Math.max(0, assessableAssets - dt) * DEEM_HIGH;
  let employment = 0;
  if (opts.p1WorkIncome !== undefined || opts.p2WorkIncome !== undefined) {
    const p1Emp = opts.p1WorkIncome ? Math.max(0, opts.p1WorkIncome - (opts.p1Eligible ? WORK_BONUS : 0)) : 0;
    const p2Emp = opts.p2WorkIncome ? Math.max(0, opts.p2WorkIncome - (opts.p2Eligible ? WORK_BONUS : 0)) : 0;
    employment = p1Emp + p2Emp;
  } else {
    employment = Math.max(0, (opts.otherIncome || 0) - WORK_BONUS);
  }
  const freeArea = couple ? INCOME_FREE_COUPLE : INCOME_FREE_SINGLE;
  const incomeTest = Math.max(0, maxRate - Math.max(0, deemed + employment - freeArea) * 0.5 * scale);
  return Math.min(assetTest, incomeTest);
}

// ══════════════════════════════════════════════════════════
//  FIRE CALCULATIONS
// ══════════════════════════════════════════════════════════

const fiNumber    = (expenses, swr) => expenses / swr;
const coastTarget = (fi, years, r)  => fi / Math.pow(1 + r, years);
const annuityPV   = (pmt, years, r, due = false) => {
  if (years <= 0 || pmt === 0) return 0;
  const base = Math.abs(r) < 1e-5 ? pmt * years : pmt * (1 - Math.pow(1 + r, -years)) / r;
  return due ? base * (1 + r) : base;
};

function earlyFIBridge(realExpenses, superNowReal, yearsToPreserve, realInvR, realSupR, swr) {
  const N = yearsToPreserve;
  if (N <= 0) return realExpenses / swr;
  const bridge = annuityPV(realExpenses, N, realInvR, true);
  const superAtPreserve = superNowReal * Math.pow(1 + realSupR, N);
  const fi60    = realExpenses / swr;
  const deficit = Math.max(0, fi60 - superAtPreserve) / Math.pow(1 + realInvR, N);
  return bridge + deficit;
}

// Annual P&I repayment on a nominal mortgage (standard monthly annuity × 12).
// Returns 0 if amount or term is zero.
function annualMortgageRepayment(principal, annualRate, termYears) {
  if (principal <= 0 || termYears <= 0) return 0;
  if (annualRate <= 0) return principal / termYears;
  const r = annualRate / 12;
  const n = termYears * 12;
  const monthly = principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  return monthly * 12;
}

// Exact 12-month mortgage amortization step with optional year-end extra repayment.
function amortizeMortgageYear(balance, annualRate, monthlyBasePmt, annualExtraNominal = 0) {
  if (balance <= 0) return { endBalance: 0, basePaid: 0, extraPaid: 0 };
  const r = annualRate > 0 ? annualRate / 12 : 0;
  let bal = balance;
  let basePaid = 0;
  for (let m = 0; m < 12 && bal > 0; m++) {
    bal *= (1 + r);
    const pmt = Math.min(bal, monthlyBasePmt);
    bal -= pmt;
    basePaid += pmt;
  }
  const extraPaid = Math.min(bal, Math.max(0, annualExtraNominal));
  bal -= extraPaid;
  if (bal < 1e-6) bal = 0;
  return { endBalance: bal, basePaid, extraPaid };
}

// Effective full expenses at a given age, adjusted for house purchase/mortgage/payoff.
// Used for standalone FI-target comparisons.
function houseExpAdjAt(inp, age) {
  const { currentAge = 0, houseDeposit = 0, houseBuyAge = 0, mortgageAmount = 0, rentSaving = 0,
          mortgageRate = 0, mortgageTerm = 0, fullExpenses, inflation = 0 } = inp;
  const active = houseDeposit > 0 || mortgageAmount > 0;
  const effBuyAge = active ? Math.max(currentAge, houseBuyAge) : 0;
  if (!active || age < effBuyAge) return fullExpenses;
  const repaymentNominal = annualMortgageRepayment(mortgageAmount, mortgageRate, mortgageTerm);
  const repaymentReal = repaymentNominal / Math.pow(1 + inflation, age - effBuyAge);
  const paidAge   = mortgageTerm > 0 ? effBuyAge + mortgageTerm : null;
  const adj = (paidAge == null || age < paidAge) ? (repaymentReal - rentSaving) : -rentSaving;
  return Math.max(0, fullExpenses + adj);
}

// Liquid wealth target at `fromAge` accounting for per-person preservation ages,
// exact pre-60 bridge, house purchase transitions, and optional Barista income.
function houseAwareTarget(inp, baseExp, fromAge, p2AgeAtFrom, lockedSup1, lockedSup2, realR, realSupR, swr, paidAgeEst, incomeNet = 0, stopAge = 0) {
  const {
    currentAge = 0, couple = false, houseDeposit = 0, houseBuyAge = 0,
    mortgageAmount = 0, rentSaving = 0, mortgageRate = 0, mortgageTerm = 0, inflation = 0,
  } = inp;
  const houseActive = houseDeposit > 0 || mortgageAmount > 0;
  const effBuyAge = houseActive ? Math.max(currentAge, houseBuyAge) : 0;
  const steadyExp = Math.max(0, baseExp - (houseActive ? rentSaving : 0));
  const repayNom = annualMortgageRepayment(mortgageAmount, mortgageRate, mortgageTerm);
  const finalPaidAge = paidAgeEst ?? (mortgageTerm > 0 ? effBuyAge + mortgageTerm : null);

  const y1 = lockedSup1 > 0 && fromAge < PRESERVATION_AGE ? PRESERVATION_AGE - fromAge : 0;
  const y2 = couple && lockedSup2 > 0 && p2AgeAtFrom < PRESERVATION_AGE ? PRESERVATION_AGE - p2AgeAtFrom : 0;
  const horizon = Math.max(y1, y2);
  const horizonAge = fromAge + horizon;

  const yearSpend = (ageAtYr) => {
    let houseAdj = 0;
    if (houseActive) {
      if (ageAtYr < effBuyAge) houseAdj = 0;
      else if (finalPaidAge == null || ageAtYr < finalPaidAge) {
        houseAdj = repayNom / Math.pow(1 + inflation, ageAtYr - effBuyAge) - rentSaving;
      } else {
        houseAdj = -rentSaving;
      }
    }
    const inc = (incomeNet > 0 && ageAtYr < stopAge) ? incomeNet : 0;
    return Math.max(0, baseExp + houseAdj - inc);
  };

  // Helper: PV at startYr (relative to fromAge) of bridge spending from startYr to endYr-1
  const spanPV = (startYr, endYr) => {
    let pv = 0;
    for (let k = startYr; k < endYr; k++) {
      const ageAtK = fromAge + k;
      let cost = yearSpend(ageAtK);
      // Deposit is drawn at start of effBuyAge (except if effBuyAge === fromAge and already counted/drawn)
      if (houseActive && houseDeposit > 0 && ageAtK === effBuyAge && effBuyAge > fromAge) {
        cost += houseDeposit;
      }
      pv += cost / Math.pow(1 + realR, k - startYr);
    }
    return pv;
  };

  // Post-horizon steady-state FI + finite house transition costs at horizonAge
  let postHouseExtraPV = 0;
  if (houseActive) {
    if (effBuyAge > horizonAge) {
      // Still renting from horizonAge until effBuyAge, then deposit
      const rentYears = effBuyAge - horizonAge;
      postHouseExtraPV += annuityPV(rentSaving, rentYears, realR, true);
      if (houseDeposit > 0) postHouseExtraPV += houseDeposit / Math.pow(1 + realR, rentYears);
    } else if (houseDeposit > 0 && effBuyAge === horizonAge && horizonAge > fromAge) {
      postHouseExtraPV += houseDeposit;
    }
    if (finalPaidAge != null && finalPaidAge > horizonAge) {
      const startMortAge = Math.max(horizonAge, effBuyAge);
      for (let a = startMortAge; a < finalPaidAge; a++) {
        const repReal = repayNom / Math.pow(1 + inflation, a - effBuyAge);
        postHouseExtraPV += repReal / Math.pow(1 + realR, a - horizonAge);
      }
    }
  }
  const postBaristaPV = incomeNet > 0 && stopAge > horizonAge
    ? annuityPV(incomeNet, stopAge - horizonAge, realR, true)
    : 0;
  const needAtHorizon = Math.max(0, fiNumber(steadyExp, swr) + postHouseExtraPV - postBaristaPV);

  if (y1 === 0 && y2 === 0) return needAtHorizon;

  // Single locked super pool
  if (y1 > 0 && y2 === 0) {
    const sup1AtY1 = lockedSup1 * Math.pow(1 + realSupR, y1);
    const deficitAtY1 = Math.max(0, needAtHorizon - sup1AtY1);
    return spanPV(0, y1) + deficitAtY1 / Math.pow(1 + realR, y1);
  }
  if (y2 > 0 && y1 === 0) {
    const sup2AtY2 = lockedSup2 * Math.pow(1 + realSupR, y2);
    const deficitAtY2 = Math.max(0, needAtHorizon - sup2AtY2);
    return spanPV(0, y2) + deficitAtY2 / Math.pow(1 + realR, y2);
  }

  // Two locked super pools: backward induction from later unlock to earlier unlock
  const firstY  = Math.min(y1, y2);
  const secondY = Math.max(y1, y2);
  const firstSup  = y1 <= y2 ? lockedSup1 : lockedSup2;
  const secondSup = y1 <= y2 ? lockedSup2 : lockedSup1;
  const secondAtUnlock = secondSup * Math.pow(1 + realSupR, secondY);
  const deficitAtSecond = Math.max(0, needAtHorizon - secondAtUnlock);
  const needAtFirst = spanPV(firstY, secondY) + deficitAtSecond / Math.pow(1 + realR, secondY - firstY);
  const firstAtUnlock = firstSup * Math.pow(1 + realSupR, firstY);
  const deficitAtFirst = Math.max(0, needAtFirst - firstAtUnlock);
  return spanPV(0, firstY) + deficitAtFirst / Math.pow(1 + realR, firstY);
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
    mortgageRate = 0, mortgageTerm = 0, extraRepaymentPct = 0,
  } = inp;

  // Exact monthly P&I payment and effective buy age (past buy ages execute immediately at currentAge).
  const mortgageRepaymentNominal = annualMortgageRepayment(mortgageAmount, mortgageRate, mortgageTerm);
  const monthlyBasePmt    = mortgageRepaymentNominal / 12;
  const houseBuyActive    = houseDeposit > 0 || mortgageAmount > 0;
  const effHouseBuyAge    = houseBuyActive ? Math.max(currentAge, houseBuyAge) : 0;
  let loanBalance = 0;
  let mortgagePaidAge = null;

  const light = !!opts.light;          // Monte Carlo mode: skip rows/milestones
  const vol   = opts.vol || 0;
  const shock = opts.shock || null;

  const realR       = (1 + investReturn) / (1 + inflation) - 1;
  const realSupR    = (1 + superReturn) / (1 + inflation) - 1;
  const realSupPenR = (1 + superReturn + 0.01) / (1 + inflation) - 1; // ~1.0% boost in tax-free pension phase
  const realCashR   = (1 + cashReturn) / (1 + inflation) - 1;

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
  let partnerHelpPaidOffAge = null;

  let p1CarryFwd = carryForwardCap;
  let p2CarryFwd = partnerCarryForwardCap;

  const splitInvIncome = (assessable, p1Base, p2Base) => {
    if (assessable <= 0) return [0, 0];
    if (!couple) return [assessable, 0];
    if (investHolder === 'higher') return p1Base >= p2Base ? [assessable, 0] : [0, assessable];
    if (investHolder === 'split')  return [assessable / 2, assessable / 2];
    return p1Base <= p2Base ? [assessable, 0] : [0, assessable];
  };

  // Tax on nominal investment distributions & cash interest, expressed in real dollars.
  // Also captures incremental MLS and HECS repayments triggered by investment income.
  const calcInvAndCashTax = (invBase, cashBase, p1TaxBase, p2TaxBase, p1MlsBase, p2MlsBase, age, p2AgeNow, rInvNow) => {
    const nomInvR = (1 + rInvNow) * (1 + inflation) - 1;
    const assessable =
      invBase * Math.max(0, nomInvR) * taxableShare / (1 + inflation) +
      cashBase * Math.max(0, cashReturn) / (1 + inflation);
    if (assessable <= 0) return { invTax: 0, p1InvInc: 0, p2InvInc: 0, p1HecsDelta: 0, p2HecsDelta: 0 };

    const [p1InvInc, p2InvInc] = splitInvIncome(assessable, p1TaxBase, p2TaxBase);
    const p1Sen = age >= AGE_PENSION_AGE;
    const p2Sen = couple && p2AgeNow >= AGE_PENSION_AGE;

    let invTax =
      taxOnExtraIncome(p1TaxBase, p1InvInc, p1Sen, couple) +
      (couple ? taxOnExtraIncome(p2TaxBase, p2InvInc, p2Sen, couple) : 0);

    if (!privateHealth) {
      const combBefore = p1MlsBase + p2MlsBase;
      const combAfter  = combBefore + p1InvInc + p2InvInc;
      const mlsBefore  = mlsAmount(p1MlsBase, combBefore, couple) + (couple ? mlsAmount(p2MlsBase, combBefore, couple) : 0);
      const mlsAfter   = mlsAmount(p1MlsBase + p1InvInc, combAfter, couple) + (couple ? mlsAmount(p2MlsBase + p2InvInc, combAfter, couple) : 0);
      invTax += Math.max(0, mlsAfter - mlsBefore);
    }

    let p1HecsDelta = 0, p2HecsDelta = 0;
    if (p1Help > 0 && p1InvInc > 0) {
      p1HecsDelta = Math.min(p1Help, Math.max(0, hecsRepayment(p1MlsBase + p1InvInc) - hecsRepayment(p1MlsBase)));
      p1Help -= p1HecsDelta;
      if (hecsActive && helpPaidOffAge == null && p1Help <= 0) helpPaidOffAge = age;
      invTax += p1HecsDelta;
    }
    if (couple && p2Help > 0 && p2InvInc > 0) {
      p2HecsDelta = Math.min(p2Help, Math.max(0, hecsRepayment(p2MlsBase + p2InvInc) - hecsRepayment(p2MlsBase)));
      p2Help -= p2HecsDelta;
      if (partnerHecsActive && partnerHelpPaidOffAge == null && p2Help <= 0) partnerHelpPaidOffAge = age;
      invTax += p2HecsDelta;
    }

    return { invTax, p1InvInc, p2InvInc, p1HecsDelta, p2HecsDelta };
  };

  const fi     = fiNumber(fullExpenses, swr);
  const leanFI = fiNumber(leanExpenses, swr);
  const baristaNet = calcTax(baristaIncome, 0, false, { noPHI: !privateHealth, family: couple }).net;

  const rows = [], totalsReal = [];
  let leanAge = null, coastAge = null, baristaAge = null, fullAge = null;
  let depleteAge = null, failed = false;

  for (let age = currentAge; age <= 90; age++) {
    const yr       = age - currentAge;
    const infAdj   = Math.pow(1 + inflation, yr);
    const retired  = age >= retirementAge;

    const z       = shock ? shock(yr) : 0;
    const rInv    = Math.max(-0.99, realR       + vol * z);
    const rSup    = Math.max(-0.99, realSupR    + vol * z);
    const rSupPen = Math.max(-0.99, realSupPenR + vol * z);

    const p2AgeNow  = couple ? partnerAge + yr : 0;
    const p2Working = couple && partnerSalary > 0 && p2AgeNow < partnerRetirementAge;
    // Each person's super unlocks at their own preservation age
    const p1Can = age >= UNRESTRICTED_AGE || (age >= PRESERVATION_AGE && retired);
    const p2Can = couple && (p2AgeNow >= UNRESTRICTED_AGE ||
      (p2AgeNow >= PRESERVATION_AGE && !p2Working));

    const p1Eligible = age >= AGE_PENSION_AGE;
    const p2Eligible = couple && p2AgeNow >= AGE_PENSION_AGE;

    // Convert eligible super to tax-free pension phase once Age Pension sheltering no longer helps
    if (!p1Tapped && p1Can && (p1Eligible || (retired && (!couple || !p2Eligible)))) p1Tapped = true;
    if (couple && !p2Tapped && p2Can && (p2Eligible || (!p2Working && !p1Eligible))) p2Tapped = true;

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
    // House purchase: draw deposit from cash then investments at buy age.
    if (houseBuyActive && age === effHouseBuyAge) {
      loanBalance = mortgageAmount;
      if (houseDeposit > 0) {
        let dep = houseDeposit;
        const c = Math.min(dep, cash); cash -= c; dep -= c;
        const i = Math.min(dep, inv);  inv  -= i; dep -= i;
        if (dep > 1 && !failed) { failed = true; depleteAge = age; }
      }
    }

    const mortgageActive = houseBuyActive && age >= effHouseBuyAge && loanBalance > 0;
    const infFromBuy = houseBuyActive && age >= effHouseBuyAge ? Math.pow(1 + inflation, age - effHouseBuyAge) : 1;
    const baseAmort = mortgageActive
      ? amortizeMortgageYear(loanBalance, mortgageRate, monthlyBasePmt, 0)
      : { endBalance: 0, basePaid: 0, extraPaid: 0 };
    const mortgageRepaymentReal = mortgageActive ? baseAmort.basePaid / infFromBuy : 0;
    const houseExpAdj = !houseBuyActive || age < effHouseBuyAge ? 0
      : mortgageActive ? (mortgageRepaymentReal - rentSaving)
      : -rentSaving;
    const isHomeowner = homeowner || (houseBuyActive && age >= effHouseBuyAge);

    let annualTax = {}, annualSavings = 0, sgContrib = 0, extraConc = 0,
        netSuperContrib = 0, pensionY = 0, supDraw = 0, invDraw = 0,
        cashDraw = 0, householdNet = 0, invTax = 0, superTax = 0;
    let extraRepaymentReal = 0;

    if (!retired) {
      // Australian taxation is individual — each earner taxed separately.
      const p1Salary = growSalary ? grossSalary : grossSalary / infAdj;
      const p2Salary = p2Working ? (growSalary ? partnerSalary : partnerSalary / infAdj) : 0;

      const p1SG  = Math.min(p1Salary, MAX_SG_BASE) * sgRate;
      const p2SG  = Math.min(p2Salary, MAX_SG_BASE) * sgRate;

      const p1BaseCap = Math.max(0, CONCESSIONAL_CAP - p1SG);
      const p1EligibleCF = sup1 < CARRY_FWD_TSB_LIMIT ? p1CarryFwd : 0;
      const p1Sac = Math.max(0, Math.min(extraConcessional, p1Salary, p1BaseCap + p1EligibleCF));
      if (p1Sac > p1BaseCap) p1CarryFwd = Math.max(0, p1CarryFwd - (p1Sac - p1BaseCap));

      const p2BaseCap = Math.max(0, CONCESSIONAL_CAP - p2SG);
      const p2EligibleCF = sup2 < CARRY_FWD_TSB_LIMIT ? p2CarryFwd : 0;
      const p2Sac = p2Working ? Math.max(0, Math.min(partnerExtraConcessional, p2Salary, p2BaseCap + p2EligibleCF)) : 0;
      if (p2Working && p2Sac > p2BaseCap) p2CarryFwd = Math.max(0, p2CarryFwd - (p2Sac - p2BaseCap));

      // Check NCC TSB eligibility for the target super account(s)
      const p1NccOk = sup1 < NCC_TSB_LIMIT;
      const p2NccOk = couple && sup2 < NCC_TSB_LIMIT && p2AgeNow < 75;
      const nccCanRoute = !couple ? p1NccOk
        : contribTarget === 'partner' ? p2NccOk
        : contribTarget === 'split'   ? (p1NccOk || p2NccOk)
        : p1NccOk;
      const nonConc = nccCanRoute ? Math.max(0, Math.min(extraNonConcessional, NON_CONCESSIONAL_CAP)) : 0;

      const mlsOpts = { noPHI: !privateHealth, family: couple, mlsCombined: p1Salary + p2Salary };
      const p1Tax = calcTax(p1Salary, p1Sac, p1Help > 0, { ...mlsOpts, isSenior: p1Eligible });
      const p2Tax = p2Salary > 0 ? calcTax(p2Salary, p2Sac, p2Help > 0, { ...mlsOpts, isSenior: p2Eligible })
        : { net: 0, raw: 0, hecs: 0, total: 0, taxable: 0 };

      // HELP: repay only until the balance is gone, then keep the cash
      const p1Repay = Math.min(p1Tax.hecs, p1Help);
      const p2Repay = Math.min(p2Tax.hecs, p2Help);
      p1Help -= p1Repay; p2Help -= p2Repay;
      if (hecsActive && helpPaidOffAge == null && p1Help <= 0) helpPaidOffAge = age;
      if (partnerHecsActive && partnerHelpPaidOffAge == null && p2Help <= 0) partnerHelpPaidOffAge = age;

      // Age Pension applies even if still working once 67+
      if (includeAgePension && (p1Eligible || p2Eligible)) {
        const assessablePen = inv + cash
          + ((p1Eligible || p1Tapped) ? sup1 : 0)
          + ((p2Eligible || p2Tapped) ? sup2 : 0);
        pensionY = agePensionEstimate(assessablePen, isHomeowner, couple, {
          bothEligible: couple ? (p1Eligible && p2Eligible) : true,
          p1WorkIncome: p1Salary,
          p2WorkIncome: p2Salary,
          p1Eligible,
          p2Eligible,
        });
      }
      const [p1PenTaxable, p2PenTaxable] = !couple ? [pensionY, 0]
        : (p1Eligible && p2Eligible) ? [pensionY / 2, pensionY / 2]
        : p1Eligible ? [pensionY, 0] : [0, pensionY];

      // Enforce mandatory minimum drawdown if any super pot is already in pension phase
      let excessToInv = 0;
      const minDrawPot = (bal, tapped, ownerAge) => {
        if (!tapped || bal <= 0) return 0;
        return Math.min(bal, bal * minDrawdownRate(ownerAge));
      };
      const p1Min = minDrawPot(sup1, p1Tapped, age);
      const p2Min = couple ? minDrawPot(sup2, p2Tapped, p2AgeNow) : 0;
      sup1 -= p1Min; sup2 -= p2Min;
      supDraw += p1Min + p2Min;
      excessToInv += p1Min + p2Min;

      const salaryTakeHome = p1Tax.net + (p1Tax.hecs - p1Repay) + p2Tax.net + (p2Tax.hecs - p2Repay);
      householdNet = salaryTakeHome;

      // Include pension + any mandatory super drawdown in available cashflow
      const cashflow = salaryTakeHome + pensionY + excessToInv - (currentExpenses + houseExpAdj) - nonConc;
      if (cashflow >= 0) {
        annualSavings = cashflow;
        if (mortgageActive && extraRepaymentPct > 0 && annualSavings > 0) {
          const desiredExtraReal = annualSavings * extraRepaymentPct;
          const fullAmort = amortizeMortgageYear(loanBalance, mortgageRate, monthlyBasePmt, desiredExtraReal * infFromBuy);
          extraRepaymentReal = fullAmort.extraPaid / infFromBuy;
          annualSavings -= extraRepaymentReal;
          loanBalance = fullAmort.endBalance;
        } else if (mortgageActive) {
          loanBalance = baseAmort.endBalance;
        }
      } else {
        if (mortgageActive) loanBalance = baseAmort.endBalance;
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
      if (mortgageActive && loanBalance <= 0 && mortgagePaidAge == null) mortgagePaidAge = age + 1;

      // Investment & cash tax on nominal returns (post-drawdown base)
      const invEndBase  = Math.max(0, inv);
      const cashEndBase = Math.max(0, cash);
      const invTaxRes = calcInvAndCashTax(
        invEndBase, cashEndBase,
        p1Tax.taxable + p1PenTaxable, p2Tax.taxable + p2PenTaxable,
        p1Salary + p1PenTaxable, p2Salary + p2PenTaxable,
        age, p2AgeNow, rInv
      );
      invTax = invTaxRes.invTax;

      const p1Conc = p1SG + p1Sac, p2Conc = p2SG + p2Sac;
      const p1SuperTax = p1Conc * 0.15 + div293Tax(p1Tax.taxable + invTaxRes.p1InvInc, p1Conc);
      const p2SuperTax = p2Conc * 0.15 + div293Tax(p2Tax.taxable + invTaxRes.p2InvInc, p2Conc);
      superTax = p1SuperTax + p2SuperTax;
      const p1ConcNet  = p1Conc - p1SuperTax;
      const p2ConcNet  = p2Conc - p2SuperTax;
      netSuperContrib  = p1ConcNet + p2ConcNet + nonConc;

      // Employer SG stays with earner; salary sacrifice only routes to an eligible (non-retired) spouse
      const p1SGNet  = p1Conc > 0 ? p1ConcNet * (p1SG / p1Conc) : 0;
      const p1SacNet = p1ConcNet - p1SGNet;
      let toSup1 = p1SGNet, toSup2 = p2ConcNet;
      if (couple && contribTarget === 'partner' && !p2Can) toSup2 += p1SacNet;
      else if (couple && contribTarget === 'split' && !p2Can) { toSup1 += p1SacNet / 2; toSup2 += p1SacNet / 2; }
      else toSup1 += p1SacNet;

      if (nonConc > 0) {
        if (couple && contribTarget === 'partner' && p2NccOk) toSup2 += nonConc;
        else if (couple && contribTarget === 'split') {
          if (p1NccOk && p2NccOk) { toSup1 += nonConc / 2; toSup2 += nonConc / 2; }
          else if (p2NccOk) toSup2 += nonConc;
          else toSup1 += nonConc;
        } else {
          toSup1 += nonConc;
        }
      }

      const totHecs = p1Repay + p2Repay + invTaxRes.p1HecsDelta + invTaxRes.p2HecsDelta;
      annualTax = {
        taxable: p1Tax.taxable + p2Tax.taxable,
        raw:   p1Tax.raw + p2Tax.raw,
        hecs:  p1Repay + p2Repay,
        total: p1Tax.raw + p2Tax.raw + p1Repay + p2Repay,
        net:   salaryTakeHome,
        p1Net: p1Tax.net + (p1Tax.hecs - p1Repay), p1Raw: p1Tax.raw, p1Hecs: p1Repay,
        totHecs,
      };
      sgContrib = p1SG + p2SG;
      extraConc = p1Sac;

      sup1 = growSuper(Math.max(0, sup1 + toSup1), p1Tapped);
      sup2 = growSuper(Math.max(0, sup2 + toSup2), p2Tapped);
      inv  = Math.max(0, inv + annualSavings) * (1 + rInv);
      cash = Math.max(0, cash) * (1 + realCashR);

    } else {
      // Full retirement path — no part-time income assumed for primary here.
      const expReal = (fullExpenses + houseExpAdj) * (slowGoPct > 0 && age >= slowGoAge ? 1 - slowGoPct : 1);

      let p2ToSup2 = 0;
      let p2Net = 0, p2SalaryNow = 0, p2TaxableNow = 0, p2ConcNow = 0;
      let p2TaxObj = { net: 0, raw: 0, hecs: 0, total: 0, taxable: 0 }, p2Repay = 0;
      if (p2Working) {
        p2SalaryNow = growSalary ? partnerSalary : partnerSalary / infAdj;
        const p2SG  = Math.min(p2SalaryNow, MAX_SG_BASE) * sgRate;
        const p2BaseCap = Math.max(0, CONCESSIONAL_CAP - p2SG);
        const p2EligibleCF = sup2 < CARRY_FWD_TSB_LIMIT ? p2CarryFwd : 0;
        const p2Sac = Math.max(0, Math.min(partnerExtraConcessional, p2SalaryNow, p2BaseCap + p2EligibleCF));
        if (p2Sac > p2BaseCap) p2CarryFwd = Math.max(0, p2CarryFwd - (p2Sac - p2BaseCap));
        p2TaxObj = calcTax(p2SalaryNow, p2Sac, p2Help > 0,
          { noPHI: !privateHealth, family: couple, mlsCombined: p2SalaryNow, isSenior: p2Eligible });
        p2Repay = Math.min(p2TaxObj.hecs, p2Help);
        p2Help -= p2Repay;
        if (partnerHecsActive && partnerHelpPaidOffAge == null && p2Help <= 0) partnerHelpPaidOffAge = age;
        p2Net = p2TaxObj.net + (p2TaxObj.hecs - p2Repay);
        p2TaxableNow = p2TaxObj.taxable;
        p2ConcNow = p2SG + p2Sac;
        sgContrib = p2SG;
        extraConc = p2Sac;
      }
      householdNet = p2Net;

      // Age Pension: per-person eligibility; an under-pension-age partner's
      // untapped accumulation super is exempt from both means tests
      if (includeAgePension && (p1Eligible || p2Eligible)) {
        const assessable = inv + cash
          + ((p1Eligible || p1Tapped) ? sup1 : 0)
          + ((p2Eligible || p2Tapped) ? sup2 : 0);
        pensionY = agePensionEstimate(assessable, isHomeowner, couple, {
          bothEligible: couple ? (p1Eligible && p2Eligible) : true,
          p1WorkIncome: 0,
          p2WorkIncome: p2SalaryNow,
          p1Eligible,
          p2Eligible,
        });
      }
      const [p1PenTaxable, p2PenTaxable] = !couple ? [pensionY, 0]
        : (p1Eligible && p2Eligible) ? [pensionY / 2, pensionY / 2]
        : p1Eligible ? [pensionY, 0] : [0, pensionY];

      let needed = expReal - p2Net - pensionY;
      let surplusToInv = 0;
      if (needed < 0) {
        annualSavings = -needed;
        if (mortgageActive && extraRepaymentPct > 0 && annualSavings > 0) {
          const desiredExtraReal = annualSavings * extraRepaymentPct;
          const fullAmort = amortizeMortgageYear(loanBalance, mortgageRate, monthlyBasePmt, desiredExtraReal * infFromBuy);
          extraRepaymentReal = fullAmort.extraPaid / infFromBuy;
          annualSavings -= extraRepaymentReal;
          loanBalance = fullAmort.endBalance;
        } else if (mortgageActive) {
          loanBalance = baseAmort.endBalance;
        }
        surplusToInv = annualSavings;
        needed = 0;
      } else if (mortgageActive) {
        loanBalance = baseAmort.endBalance;
      }
      if (mortgageActive && loanBalance <= 0 && mortgagePaidAge == null) mortgagePaidAge = age + 1;

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

      // Investment & cash income taxed on post-drawdown balances at nominal rates
      const invEndBase  = Math.max(0, inv - invDraw);
      const cashEndBase = Math.max(0, cash - cashDraw);
      const invTaxRes = calcInvAndCashTax(
        invEndBase, cashEndBase,
        p1PenTaxable, p2TaxableNow + p2PenTaxable,
        p1PenTaxable, p2SalaryNow + p2PenTaxable,
        age, p2AgeNow, rInv
      );
      invTax = invTaxRes.invTax;

      if (p2Working) {
        const p2SuperTax = p2ConcNow * 0.15 + div293Tax(p2TaxableNow + invTaxRes.p2InvInc, p2ConcNow);
        superTax = p2SuperTax;
        p2ToSup2 = p2ConcNow - p2SuperTax;
        netSuperContrib = p2ToSup2;
        annualTax = {
          taxable: p2TaxObj.taxable,
          raw: p2TaxObj.raw,
          hecs: p2Repay,
          total: p2TaxObj.raw + p2Repay,
          net: p2Net,
          p1Net: 0, p1Raw: 0, p1Hecs: 0,
          totHecs: p2Repay + invTaxRes.p1HecsDelta + invTaxRes.p2HecsDelta,
        };
      } else {
        annualTax = {
          taxable: 0, raw: 0, hecs: 0, total: 0, net: 0, p1Net: 0, p1Raw: 0, p1Hecs: 0,
          totHecs: invTaxRes.p1HecsDelta + invTaxRes.p2HecsDelta,
        };
      }

      sup1 = growSuper(Math.max(0, sup1), p1Tapped);
      sup2 = growSuper(Math.max(0, sup2 + p2ToSup2), p2Tapped);
      inv  = Math.max(0, inv - invDraw + surplusToInv + excessToInv) * (1 + rInv);
      cash = Math.max(0, cash - cashDraw) * (1 + realCashR);
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
      const p1Unlocked = age >= PRESERVATION_AGE;
      const p2Unlocked = couple && p2AgeNow >= PRESERVATION_AGE;
      const accessible = (p1Unlocked ? sup1 : 0) + (p2Unlocked ? sup2 : 0) + inv + cash;
      const lockedSup1 = p1Unlocked ? 0 : sup1;
      const lockedSup2 = (!couple || p2Unlocked) ? 0 : sup2;

      const paidAgeEst = mortgagePaidAge ?? (mortgageTerm > 0 ? effHouseBuyAge + mortgageTerm : null);

      const leanTgt = houseAwareTarget(inp, leanExpenses, age, p2AgeNow, lockedSup1, lockedSup2, realR, realSupR, swr, paidAgeEst);
      const baristaTgt = houseAwareTarget(inp, baristaExpenses, age, p2AgeNow, lockedSup1, lockedSup2, realR, realSupR, swr, paidAgeEst, baristaNet, baristaStopAge);
      const fullTgt = houseAwareTarget(inp, fullExpenses, age, p2AgeNow, lockedSup1, lockedSup2, realR, realSupR, swr, paidAgeEst);

      // Coast target: wealth needed today so with $0 further contributions it hits the FI target at retirementAge.
      let coastNow;
      let coastCheckW;
      const yrsToRet = Math.max(0, retirementAge - age);
      const p2AtRet = couple ? partnerAge + (retirementAge - currentAge) : 0;
      if (yrsToRet === 0) {
        coastNow = fullTgt;
        coastCheckW = accessible;
      } else if (retirementAge >= PRESERVATION_AGE && (!couple || p2AtRet >= PRESERVATION_AGE)) {
        const fiAtRet = houseAwareTarget(inp, fullExpenses, retirementAge, p2AtRet, 0, 0, realR, realSupR, swr, paidAgeEst);
        coastNow = coastTarget(fiAtRet, yrsToRet, realR);
        coastCheckW = total;
      } else {
        const sup1AtRet = retirementAge < PRESERVATION_AGE ? sup1 * Math.pow(1 + realSupR, yrsToRet) : 0;
        const sup2AtRet = (couple && p2AtRet < PRESERVATION_AGE) ? sup2 * Math.pow(1 + realSupR, yrsToRet) : 0;
        const liquidAtRetNeeded = houseAwareTarget(
          inp, fullExpenses, retirementAge, p2AtRet, sup1AtRet, sup2AtRet, realR, realSupR, swr, paidAgeEst
        );
        coastNow = liquidAtRetNeeded / Math.pow(1 + realR, yrsToRet);
        coastCheckW = (retirementAge >= PRESERVATION_AGE ? sup1 : (p1Unlocked ? sup1 : 0))
          + (couple && p2AtRet >= PRESERVATION_AGE ? sup2 : (p2Unlocked ? sup2 : 0))
          + inv + cash;
      }

      if (!leanAge    && accessible >= leanTgt)    leanAge    = age;
      if (!coastAge   && coastCheckW >= coastNow)  coastAge   = age;
      if (!baristaAge && accessible >= baristaTgt) baristaAge = age;
      if (!fullAge    && accessible >= fullTgt)    fullAge    = age;

      rows.push({
        age, yr, infAdj, retired,
        totalReal: total, supReal: sup1 + sup2, sup1Real: sup1, sup2Real: sup2,
        invReal: inv, cashReal: cash,
        accessibleReal: accessible,
        coastNow, leanTgt, baristaTgt, fullTgt,
        annualSavings, sgContrib, extraConc, netSuperContrib, annualTax, invTax, superTax,
        pension: pensionY, supDraw, invDraw, cashDraw, householdNet,
        houseExpAdj, mortgageRepaymentReal, mortgageActive, isHouseOwned: isHomeowner,
      });
    }
  }

  if (light) return { totalsReal, failed, depleteAge };

  // Safety net for inverted expense configs (warned about separately)
  if (fullAge && !leanAge    && leanExpenses    <= fullExpenses) leanAge    = fullAge;
  if (fullAge && !baristaAge && baristaExpenses <= fullExpenses) baristaAge = fullAge;

  const bridgeAtRetirement = retirementAge >= PRESERVATION_AGE ? 0 : (() => {
    const retRow = rows.find(r => r.age === retirementAge);
    return retRow ? retRow.fullTgt : 0;
  })();

  return {
    rows, totalsReal,
    milestones: { leanAge, coastAge, baristaAge, fullAge, retireBefore60: retirementAge < PRESERVATION_AGE, mortgagePaidAge },
    targets: {
      fi, leanFI,
      fiEff:     rows.find(r => r.age === retirementAge)?.fullTgt    ?? fi,
      leanFIEff: rows.find(r => r.age === retirementAge)?.leanTgt    ?? leanFI,
      baristaFI: rows[0] ? rows[0].baristaTgt : fiNumber(Math.max(0, baristaExpenses - baristaNet), swr),
    },
    bridgeAtRetirement,
    currentTax: rows[0]?.annualTax || {},
    currentSavings: rows[0]?.annualSavings || 0,
    depleteAge, failed, helpPaidOffAge, partnerHelpPaidOffAge,
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
  const totalSal = (inp.grossSalary || 0) + (inp.partnerSalary || 0);
  const p2Share = inp.partnerSalary > 0 ? (totalSal > 0 ? inp.partnerSalary / totalSal : 0.5) : 0;
  const houseActive = inp.houseDeposit > 0 || inp.mortgageAmount > 0;
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
    currentExpenses:      inp.currentExpenses * p2Share,
    extraConcessional:    inp.partnerExtraConcessional || 0,
    carryForwardCap:      inp.partnerCarryForwardCap || 0,
    partnerCarryForwardCap: 0,
    extraNonConcessional: 0,
    windfallAmount: 0, oneOffAmount: 0,
    houseBuyAge:    houseActive ? inp.partnerAge + Math.max(0, inp.houseBuyAge - inp.currentAge) : 0,
    houseDeposit:   houseActive ? inp.houseDeposit * 0.5 : 0,
    mortgageAmount: houseActive ? inp.mortgageAmount * 0.5 : 0,
    rentSaving:     houseActive ? inp.rentSaving * 0.5 : 0,
    leanExpenses:         Math.max(0, inp.leanExpenses - p1Net),
    baristaExpenses:      Math.max(0, inp.baristaExpenses - p1Net),
    fullExpenses:         Math.max(0, inp.fullExpenses - p1Net),
  });
}

function projectPrimary(inp, p2Net) {
  if (!inp.couple) return null;
  const totalSal = (inp.grossSalary || 0) + (inp.partnerSalary || 0);
  const p1Share = inp.grossSalary > 0 ? (totalSal > 0 ? inp.grossSalary / totalSal : 0.5) : 0;
  const houseActive = inp.houseDeposit > 0 || inp.mortgageAmount > 0;
  return project({
    ...inp,
    partnerSalary:        0,
    couple:               false,
    partnerHecsActive:    false,
    partnerSuperBalance:  0,
    partnerCarryForwardCap: 0,
    partnerInvestBalance: 0,
    partnerCashBalance:   0,
    currentExpenses:      inp.currentExpenses * p1Share,
    windfallAmount: 0, oneOffAmount: 0,
    houseDeposit:   houseActive ? inp.houseDeposit * 0.5 : 0,
    mortgageAmount: houseActive ? inp.mortgageAmount * 0.5 : 0,
    rentSaving:     houseActive ? inp.rentSaving * 0.5 : 0,
    leanExpenses:         Math.max(0, inp.leanExpenses - p2Net),
    baristaExpenses:      Math.max(0, inp.baristaExpenses - p2Net),
    fullExpenses:         Math.max(0, inp.fullExpenses - p2Net),
  });
}

// ══════════════════════════════════════════════════════════
//  FORMATTING HELPERS
// ══════════════════════════════════════════════════════════

const fmt  = n => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-AU');
const fmtK = n => {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + (abs >= 1e6 ? '$' + (abs / 1e6).toFixed(2) + 'M' : '$' + Math.round(abs / 1000) + 'K');
};
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
  } catch (_) {}
}

function loadState() {
  try {
    let savedStr = localStorage.getItem(STORAGE_KEY);
    // One-time migration from legacy cookie to localStorage, then remove cookie
    const cookieMatch = document.cookie.match(new RegExp('(^| )' + STORAGE_KEY + '=([^;]+)'));
    if (cookieMatch) {
      if (!savedStr) {
        savedStr = decodeURIComponent(cookieMatch[2]);
        localStorage.setItem(STORAGE_KEY, savedStr);
      }
      document.cookie = `${STORAGE_KEY}=; max-age=0; path=/; SameSite=Strict`;
    }
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

let _toastTimer;
function showToast(msg, type = 'good') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2400);
}

function focusMilestone(cardId) {
  const el = document.getElementById(cardId);
  if (!el) return;
  el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  el.classList.remove('pulse-highlight');
  void el.offsetWidth;
  el.classList.add('pulse-highlight');
  setTimeout(() => el.classList.remove('pulse-highlight'), 950);
}

const SVG_CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34D399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_SUN   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
const SVG_MOON  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function shareLink() {
  const p = new URLSearchParams();
  document.querySelectorAll('.input-panel input[id], .input-panel select[id]').forEach(el => {
    p.set(el.id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
  });
  const base = (location.origin && location.origin !== 'null')
    ? (location.origin + location.pathname)
    : location.href.split('?')[0];
  const url = base + '?' + p.toString();
  const btn = document.getElementById('share-btn');
  const done = () => {
    showToast('Shareable link copied to clipboard');
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = SVG_CHECK;
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => prompt('Copy this link:', url));
  else prompt('Copy this link:', url);
}

function copyAuditLogs() {
  if (!_lastInp || !_lastResult) return showToast('No diagnostic logs generated yet');
  const auditLog = [
    '🔥 FIRE Calculator Audit Logs (Calculations & Output)',
    '1. Parsed Inputs:\n' + JSON.stringify(_lastInp, null, 2),
    '2. Base Projection Result:\n' + JSON.stringify(_lastResult, null, 2),
    '3. Monte Carlo Result:\n' + JSON.stringify(_lastMc, null, 2),
    _lastInp.couple ? '4. Partner Projection Result:\n' + JSON.stringify(_lastPartnerResult, null, 2) : '',
    _lastInp.couple ? '5. Primary Individual Projection Result:\n' + JSON.stringify(_lastPrimaryResult, null, 2) : ''
  ].filter(Boolean).join('\n\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(auditLog).then(() => {
      showToast('Diagnostic audit logs copied to clipboard');
    }).catch(() => {
      prompt('Your browser blocked clipboard access. Copy the logs here:', auditLog);
    });
  } else {
    prompt('Copy the logs here:', auditLog);
  }
}

function resetDefaults() {
  if (!confirm('Reset all inputs to defaults?')) return;
  localStorage.removeItem(STORAGE_KEY);
  document.cookie = `${STORAGE_KEY}=; max-age=0; path=/; SameSite=Strict`;
  location.href = location.href.split('?')[0];
}

function exportCSV() {
  if (!_lastRows.length) return;
  const isCouple = !!_lastInp?.couple;
  const cols = ['Age', ...(isCouple ? ['Partner age'] : []), 'Phase', 'Net income', 'Income & inv tax', 'Super tax',
    'Savings to investments', 'Net super contributions', 'Age pension', 'Mortgage repayment',
    'Super drawdown', 'Investment drawdown', 'Cash drawdown', 'Super balance', 'Investments', 'Cash', 'Total wealth'];
  const lines = [cols.join(',')];
  _lastRows.forEach(r => {
    const p2Age = _lastInp.partnerAge + r.yr;
    lines.push([
      r.age,
      ...(isCouple ? [p2Age] : []),
      r.retired ? 'Retired' : 'Working',
      Math.round(r.annualTax.net ?? r.householdNet),
      Math.round((r.annualTax.total ?? 0) + (r.invTax ?? 0)),
      Math.round(r.superTax ?? 0),
      Math.round(r.annualSavings), Math.round(r.netSuperContrib),
      Math.round(r.pension), Math.round(r.mortgageRepaymentReal ?? 0),
      Math.round(r.supDraw), Math.round(r.invDraw), Math.round(r.cashDraw),
      Math.round(r.supReal), Math.round(r.invReal), Math.round(r.cashReal), Math.round(r.totalReal),
    ].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fire-projection.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Exported fire-projection.csv');
}

// ══════════════════════════════════════════════════════════
//  DARK MODE
// ══════════════════════════════════════════════════════════

function isDark() { return document.body.classList.contains('dark'); }

function updateDarkToggleIcon(dark) {
  const btn = document.getElementById('dark-toggle');
  if (btn) btn.innerHTML = dark ? SVG_SUN : SVG_MOON;
}

function toggleDark() {
  const dark = document.body.classList.toggle('dark');
  localStorage.setItem('au-fire-dark', dark ? '1' : '0');
  updateDarkToggleIcon(dark);
  Chart.defaults.color = dark ? '#94A3B8' : '#64748B';
  _calc();
}

function initDark() {
  let darkStr = localStorage.getItem('au-fire-dark');
  const cookieMatch = document.cookie.match(/(^| )au-fire-dark=([^;]+)/);
  if (cookieMatch) {
    if (!darkStr) {
      darkStr = cookieMatch[2];
      localStorage.setItem('au-fire-dark', darkStr);
    }
    document.cookie = 'au-fire-dark=; max-age=0; path=/; SameSite=Strict';
  }

  const dark = darkStr === '1';
  if (dark) {
    document.body.classList.add('dark');
    Chart.defaults.color = '#94A3B8';
  }
  updateDarkToggleIcon(dark);
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
  const pos = id => Math.max(0, num(id));
  const chk = id => { const el = g(id); return el ? el.checked : false; };
  const sel = id => { const el = g(id); return el ? el.value : ''; };

  const couple     = sel('status') === 'couple';
  const partnerAge = Math.max(18, Math.min(70, parseInt(g('partnerAge')?.value, 10) || 30));
  const rawPRetire = parseInt(g('partnerRetirementAge')?.value, 10) || 55;
  const partnerRetirementAge = Math.max(partnerAge + 1, rawPRetire);

  const hasHECS            = chk('hasHECS');
  const hecsBalance        = pos('hecsBalance');
  const partnerHasHECS     = chk('partnerHasHECS');
  const partnerHecsBalance = pos('partnerHecsBalance');

  const planHousePurchase = chk('planHousePurchase');

  return {
    currentAge:    Math.max(18, Math.min(70, parseInt(g('currentAge').value, 10) || 35)),
    retirementAge: parseInt(g('retirementAge').value, 10) || 55,
    grossSalary:   pos('grossSalary'),
    partnerSalary: couple ? pos('partnerSalary') : 0,
    sgRate:        pos('sgRate') / 100,
    extraConcessional:        pos('extraConcessional'),
    extraNonConcessional:     pos('extraNonConcessional'),
    partnerExtraConcessional: couple ? pos('partnerExtraConcessional') : 0,
    carryForwardCap:          pos('carryForwardCap'),
    partnerCarryForwardCap:   couple ? pos('partnerCarryForwardCap') : 0,
    currentExpenses:  pos('currentExpenses'),
    leanExpenses:     pos('leanExpenses'),
    baristaExpenses:  pos('baristaExpenses'),
    baristaIncome:    pos('baristaIncome'),
    baristaStopAge:   pos('baristaStopAge') || 65,
    fullExpenses:     pos('fullExpenses'),
    superBalance:         pos('superBalance'),
    partnerSuperBalance:  couple ? pos('partnerSuperBalance') : 0,
    investBalance:        pos('investBalance'),
    cashBalance:          pos('cashBalance'),
    partnerInvestBalance: couple ? pos('partnerInvestBalance') : 0,
    partnerCashBalance:   couple ? pos('partnerCashBalance') : 0,
    investReturn:  num('investReturn') / 100,
    superReturn:   num('superReturn')  / 100,
    cashReturn:    pos('cashReturn')   / 100,
    inflation:     pos('inflation')    / 100,
    swr:           Math.max(0.01, num('swr') / 100),
    taxableShare:  Math.min(1, pos('taxableShare') / 100),
    retVol:        pos('retVol')       / 100,
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
    slowGoAge:      pos('slowGoAge') || 75,
    slowGoPct:      Math.min(1, pos('slowGoPct') / 100),
    windfallAmount: pos('windfallAmount'),
    windfallAge:    pos('windfallAge'),
    oneOffAmount:   pos('oneOffAmount'),
    oneOffAge:      pos('oneOffAge'),
    planHousePurchase,
    houseDeposit:   planHousePurchase ? pos('houseDeposit') : 0,
    houseBuyAge:    planHousePurchase ? (pos('houseBuyAge') || 40) : 0,
    mortgageAmount: planHousePurchase ? pos('mortgageAmount') : 0,
    rentSaving:     planHousePurchase ? pos('rentSaving') : 0,
    mortgageRate:   planHousePurchase ? pos('mortgageRate') / 100 : 0,
    mortgageTerm:   planHousePurchase ? (pos('mortgageTerm') || 30) : 0,
    extraRepaymentPct: planHousePurchase ? Math.min(1, pos('extraRepaymentPct') / 100) : 0,
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

Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
Chart.defaults.font.size   = 11;
Chart.defaults.color       = '#64748B';

function chartTooltipOpts(extra = {}) {
  return {
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
    titleColor: '#F8FAFC',
    bodyColor: '#CBD5E1',
    borderColor: 'rgba(148, 163, 184, 0.22)',
    borderWidth: 1,
    cornerRadius: 10,
    padding: 11,
    boxPadding: 5,
    usePointStyle: true,
    ...extra,
  };
}

// Vertical milestone marker lines with clean non-overlapping pill tags
const msLinesPlugin = {
  id: 'msLines',
  afterDatasetsDraw(chart, args, options) {
    const lines = options.lines || [];
    const xs = chart.scales.x, area = chart.chartArea, ctx = chart.ctx;
    const placed = [];
    lines.forEach(({ idx, color, label }) => {
      if (idx == null || idx < 0) return;
      const px = xs.getPixelForValue(idx);
      if (px < area.left || px > area.right) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.72;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(px, area.top);
      ctx.lineTo(px, area.bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.font = '700 9.5px Inter, sans-serif';
      const padX = 5, h = 15, w = ctx.measureText(label).width + padX * 2;
      let yOffset = 4;
      while (placed.some(p => Math.abs(p.x - px) < (p.w + w) / 2 + 4 && Math.abs(p.y - yOffset) < h + 3)) {
        yOffset += h + 3;
      }
      if (yOffset + h < area.bottom - area.top) {
        placed.push({ x: px, w, y: yOffset });
        const boxX = Math.min(Math.max(px - w / 2, area.left + 2), area.right - w - 2);
        const boxY = area.top + yOffset;
        ctx.fillStyle = color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(boxX, boxY, w, h, 4);
        else ctx.rect(boxX, boxY, w, h);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, boxX + w / 2, boxY + h / 2 + 0.5);
      }
      ctx.restore();
    });
  },
};
Chart.register(msLinesPlugin);

function gc() { return isDark() ? 'rgba(148, 163, 184, 0.08)' : 'rgba(15, 23, 42, 0.05)'; }

function makeGradient(ctx, color, alpha1 = 0.28, alpha2 = 0.01) {
  const g = ctx.createLinearGradient(0, 0, 0, 320);
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

  const totalGrad  = makeGradient(ctx, isD ? 'rgba(167,139,250,1)' : 'rgba(124,58,237,1)', 0.24, 0.01);
  const superGrad  = makeGradient(ctx, isD ? 'rgba(251,191,36,1)' : 'rgba(217,119,6,1)',   0.18, 0.01);
  const investGrad = makeGradient(ctx, isD ? 'rgba(96,165,250,1)' : 'rgba(37,99,235,1)',  0.18, 0.01);

  const ds = [
    { label: 'Total Wealth', data: data.map(r => r.totalReal), borderColor: isD ? '#A78BFA' : '#7C3AED', backgroundColor: totalGrad, fill: true, tension: 0.38, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5 },
    { label: 'Super',        data: data.map(r => r.supReal),   borderColor: isD ? '#FBBF24' : '#D97706', backgroundColor: superGrad, fill: true, tension: 0.38, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 4 },
    { label: 'Investments',  data: data.map(r => r.invReal),   borderColor: isD ? '#60A5FA' : '#2563EB', backgroundColor: investGrad, fill: true, tension: 0.38, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 4 },
    { label: 'Coast Target', data: data.map(r => r.coastNow),  borderColor: isD ? '#60A5FA' : '#2563EB', backgroundColor: 'transparent', fill: false, tension: 0.2, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
    { label: `Full FIRE target (${fmtK(targets.fiEff)})`,    data: data.map(r => r.fullTgt),    borderColor: isD ? 'rgba(167,139,250,0.6)' : 'rgba(124,58,237,0.55)', fill: false, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
    { label: `Lean FIRE target (${fmtK(targets.leanFIEff)})`, data: data.map(r => r.leanTgt),   borderColor: isD ? 'rgba(251,113,133,0.6)' : 'rgba(225,29,72,0.55)',  fill: false, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
    { label: 'Barista FIRE target',                        data: data.map(r => r.baristaTgt), borderColor: isD ? 'rgba(52,211,153,0.6)' : 'rgba(5,150,105,0.55)', fill: false, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
  ];

  if (mc) {
    ds.push(
      { label: '_p90', data: mc.p90, borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: isD ? 'rgba(167,139,250,0.12)' : 'rgba(124,58,237,0.08)', tension: 0.38 },
      { label: '_p10', data: mc.p10, borderWidth: 0, pointRadius: 0, fill: false, tension: 0.38 },
    );
  }

  const msLines = [
    { age: milestones.leanAge,         color: isD ? '#FB7185' : '#E11D48', label: 'Lean' },
    { age: milestones.coastAge,        color: isD ? '#60A5FA' : '#2563EB', label: 'Coast' },
    { age: milestones.baristaAge,      color: isD ? '#34D399' : '#059669', label: 'Barista' },
    { age: milestones.fullAge,         color: isD ? '#A78BFA' : '#7C3AED', label: 'Full' },
    { age: inp.retirementAge,          color: isD ? '#64748B' : '#475569', label: 'Retire' },
    { age: inp.houseBuyAge > 0 && (inp.houseDeposit > 0 || inp.mortgageAmount > 0) ? Math.max(firstAge, inp.houseBuyAge) : null, color: isD ? '#FBBF24' : '#D97706', label: 'Buy' },
    { age: milestones.mortgagePaidAge, color: isD ? '#FBBF24' : '#D97706', label: 'Debt-free' },
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
          labels: { boxWidth: 11, padding: 12, usePointStyle: true, font: { size: 11 }, filter: i => !i.text.startsWith('_') },
        },
        tooltip: chartTooltipOpts({
          filter: item => !item.dataset.label.startsWith('_'),
          callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` },
        }),
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
  const colors = isD ? ['#FB7185', '#60A5FA', '#34D399', '#A78BFA'] : ['#E11D48', '#2563EB', '#059669', '#7C3AED'];
  const ages1  = [milestones.leanAge, milestones.coastAge, milestones.baristaAge, milestones.fullAge];

  const datasets = [{
    label: partnerMilestones ? 'Household (combined)' : 'You',
    data: ages1.map(a => a ?? null),
    backgroundColor: colors.map(c => c + 'CC'), borderColor: colors,
    borderWidth: 1.5, borderRadius: 6,
  }];

  if (partnerMilestones && partnerAge) {
    const ages2 = [partnerMilestones.leanAge, partnerMilestones.coastAge, partnerMilestones.baristaAge, partnerMilestones.fullAge];
    datasets.push({
      label: 'Partner (sequential)',
      data: ages2.map(a => a ?? null),
      backgroundColor: colors.map(c => c + '4D'), borderColor: colors,
      borderWidth: 1.5, borderRadius: 6, borderDash: [4, 4],
    });
  }

  if (charts.timeline) charts.timeline.destroy();
  charts.timeline = new Chart(ctx, {
    type: 'bar', data: { labels, datasets },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { display: !!partnerMilestones, position: 'bottom', labels: { boxWidth: 11, padding: 12, usePointStyle: true } },
        tooltip: chartTooltipOpts({
          callbacks: {
            label: c => c.parsed.x == null ? ` ${c.dataset.label}: not reached`
              : ` ${c.dataset.label}: age ${c.parsed.x} (${Math.round(c.parsed.x - (c.datasetIndex === 0 ? currentAge : partnerAge))} yrs away)`,
          },
        }),
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

  const raw      = [fromPort, partnerY, pensionY];
  const labels   = ['Household Portfolio Drawdown', 'Partner Salary (still working)', 'Age Pension'];
  const totalSrc = Math.max(1, fromPort + partnerY + pensionY);
  const isD      = isDark();
  const colors   = isD ? ['#A78BFA', '#60A5FA', '#FBBF24'] : ['#7C3AED', '#2563EB', '#D97706'];
  const vals     = raw.map((v, i) => ({ v, l: labels[i], c: colors[i] })).filter(x => x.v > 0);

  if (charts.income) charts.income.destroy();
  charts.income = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: vals.map(x => x.l), datasets: [{ data: vals.map(x => x.v), backgroundColor: vals.map(x => x.c + 'D9'), borderColor: isD ? '#101726' : '#FFFFFF', borderWidth: 2, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '68%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 11, padding: 12, usePointStyle: true } },
        tooltip: chartTooltipOpts({ callbacks: { label: c => ` ${c.label}: ${fmt(c.parsed)} (${(c.parsed / totalSrc * 100).toFixed(0)}%)` } }),
      },
    },
  });
}

function buildTaxChart(p1Tax, p1Salary, p1SG, p1Sac = 0) {
  const ctx     = document.getElementById('chart-tax').getContext('2d');
  const takePay = p1Tax.p1Net  ?? p1Tax.net  ?? 0;
  const rawTax  = p1Tax.p1Raw  ?? p1Tax.raw  ?? 0;
  const hecs    = p1Tax.p1Hecs ?? p1Tax.hecs ?? 0;
  const superY  = p1SG;

  const raw    = [takePay, rawTax, hecs, p1Sac, superY];
  const labels = ['Take-Home', 'Tax + Medicare', 'HECS/HELP', 'Salary Sacrifice', 'Employer Super'];
  const isD    = isDark();
  const colors = isD ? ['#34D399', '#FB7185', '#FCD34D', '#60A5FA', '#FBBF24'] : ['#059669', '#E11D48', '#F59E0B', '#2563EB', '#D97706'];
  const vals   = raw.map((v, i) => ({ v, l: labels[i], c: colors[i] })).filter(x => x.v > 0);

  if (charts.tax) charts.tax.destroy();
  charts.tax = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: vals.map(x => x.l), datasets: [{ data: vals.map(x => x.v), backgroundColor: vals.map(x => x.c + 'D9'), borderColor: isD ? '#101726' : '#FFFFFF', borderWidth: 2, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '68%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 11, padding: 12, usePointStyle: true } },
        tooltip: chartTooltipOpts({ callbacks: { label: c => ` ${c.label}: ${fmt(c.parsed)} (${(c.parsed / Math.max(1, p1Salary + superY) * 100).toFixed(1)}%)` } }),
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
        { label: 'Super Contributions (net)', data: working.map(r => r.netSuperContrib), backgroundColor: isD ? 'rgba(251,191,36,0.75)' : 'rgba(217,119,6,0.75)',  borderColor: isD ? '#FBBF24' : '#D97706', borderWidth: 1, borderRadius: 4 },
        { label: 'Investment Savings',         data: working.map(r => r.annualSavings),   backgroundColor: isD ? 'rgba(96,165,250,0.75)' : 'rgba(37,99,235,0.75)', borderColor: isD ? '#60A5FA' : '#2563EB', borderWidth: 1, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 11, padding: 12, usePointStyle: true } },
        tooltip: chartTooltipOpts({ callbacks: { label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` } }),
      },
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

  const partnerHelpChip = result.partnerHelpPaidOffAge != null && inp.couple && inp.partnerHecsActive
    ? `<span class="chip">Partner HECS paid off at <b>${result.partnerHelpPaidOffAge}</b></span>` : '';

  const mortgageChip = m.mortgagePaidAge != null
    ? `<span class="chip">🏠 Mortgage-free at <b>${m.mortgagePaidAge}</b></span>` : '';

  el.innerHTML = `
    <div class="hero-kicker">${kicker}</div>
    <div class="hero-headline">${head}${m.fullAge != null && inp.couple ? ageNote : ''}</div>
    <div class="hero-chips">
      ${chip('Lean', m.leanAge)}${chip('Coast', m.coastAge)}${chip('Barista', m.baristaAge)}
      ${helpChip}${partnerHelpChip}${mortgageChip}${mcChip}
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
    const gap = inp.currentExpenses + (r0.houseExpAdj ?? 0) + Math.min(inp.extraNonConcessional, NON_CONCESSIONAL_CAP)
      - (r0.annualTax.net ?? 0) - (r0.pension ?? 0);
    if (gap > 1)
      warnings.push(`Spending exceeds take-home pay by ${fmt(gap)}/yr — the shortfall is drawn from savings.`);
  }

  if (result.depleteAge != null)
    warnings.push(`Portfolio runs dry at age ${result.depleteAge} under base assumptions.`);

  // House purchase warnings
  if (inp.houseDeposit > 0 || inp.mortgageAmount > 0) {
    if (inp.houseBuyAge <= inp.currentAge)
      warnings.push(`House buy age is at or before your current age — deposit and mortgage start immediately at age ${inp.currentAge}.`);
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

function renderJointSummary(inp, p1SeqMilestones, p2SeqMilestones, householdMilestones) {
  const el = document.getElementById('joint-summary');
  if (!el) return;

  const p1Full = p1SeqMilestones?.fullAge ?? null;
  const p2Full = p2SeqMilestones?.fullAge ?? null;
  const hhFull = householdMilestones?.fullAge ?? null;

  if (!p1Full && !p2Full && !hhFull) {
    el.innerHTML = `<p class="joint-none">Neither reaches Full FIRE by age 90 with current assumptions.</p>`;
    return;
  }

  const p1YearsToFull = p1Full != null ? p1Full - inp.currentAge : null;
  const p2YearsToFull = p2Full != null ? p2Full - inp.partnerAge : null;
  const hhYearsToFull = hhFull != null ? hhFull - inp.currentAge : null;

  const currentYear = new Date().getFullYear();
  const p1CalYear = p1YearsToFull != null ? currentYear + p1YearsToFull : null;
  const p2CalYear = p2YearsToFull != null ? currentYear + p2YearsToFull : null;
  const hhCalYear = hhYearsToFull != null ? currentYear + hhYearsToFull : null;

  let firstLabel, firstYear, firstAge, secondLabel, gapYears;
  if (p1CalYear != null && (p2CalYear == null || p1CalYear <= p2CalYear)) {
    firstLabel = 'You'; firstYear = p1CalYear; firstAge = p1Full;
    secondLabel = 'Partner'; gapYears = p2CalYear != null ? p2CalYear - p1CalYear : null;
  } else {
    firstLabel = 'Partner'; firstYear = p2CalYear; firstAge = p2Full;
    secondLabel = 'You'; gapYears = p1CalYear != null ? p1CalYear - p2CalYear : null;
  }

  // Sequential advantage: while one partner works, the household only needs the gap funded
  const p1SG = Math.min(inp.grossSalary, MAX_SG_BASE) * inp.sgRate;
  const p2SG = Math.min(inp.partnerSalary, MAX_SG_BASE) * inp.sgRate;
  const p1EligCF = inp.superBalance < CARRY_FWD_TSB_LIMIT ? inp.carryForwardCap : 0;
  const p2EligCF = inp.partnerSuperBalance < CARRY_FWD_TSB_LIMIT ? inp.partnerCarryForwardCap : 0;
  const p1Sac = Math.max(0, Math.min(inp.extraConcessional, inp.grossSalary, Math.max(0, CONCESSIONAL_CAP - p1SG) + p1EligCF));
  const p2Sac = Math.max(0, Math.min(inp.partnerExtraConcessional, inp.partnerSalary, Math.max(0, CONCESSIONAL_CAP - p2SG) + p2EligCF));
  const p1TaxNow = calcTax(inp.grossSalary, p1Sac, inp.hecsActive, taxOpts(inp));
  const p2TaxNow = calcTax(inp.partnerSalary, p2Sac, inp.partnerHecsActive, taxOpts(inp));
  const p1NetNow = p1TaxNow.net + (p1TaxNow.hecs - Math.min(p1TaxNow.hecs, inp.hecsActive ? inp.hecsBalance : 0));
  const p2NetNow = p2TaxNow.net + (p2TaxNow.hecs - Math.min(p2TaxNow.hecs, inp.partnerHecsActive ? inp.partnerHecsBalance : 0));

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
      const pctReduced = (seqFI / Math.max(1, householdFI) * 100).toFixed(0);
      return `<div class="joint-strategy">
        <span class="js-icon">💡</span>
        <div><strong>Sequential advantage:</strong> When ${whoRetires} retires first, ${whoWorks} keeps working and covers ${fmt(firstLabel === 'You' ? p2NetNow : p1NetNow)}/yr in expenses. ${whoRetires} only needs <strong>${seqFIStr}</strong> (${pctReduced}% of the ${fullFI} full FI number) — a meaningfully lower bar.</div>
      </div>`;
    }
    return '';
  };

  el.innerHTML = `
    <div class="joint-comparison">
      <div class="joint-person-box">
        <div class="jp-who">You (sequential)</div>
        <div class="jp-big-age" style="color:var(--full)">${p1Full ?? '90+'}</div>
        <div class="jp-small">Sequential FIRE age</div>
        <div class="jp-cal">${p1CalYear != null ? `${p1CalYear} · ${p1YearsToFull} yrs` : 'Not reached'}</div>
      </div>
      <div class="joint-divider-v"></div>
      <div class="joint-person-box">
        <div class="jp-who">Partner (sequential)</div>
        <div class="jp-big-age" style="color:var(--coast)">${p2Full ?? '90+'}</div>
        <div class="jp-small">Sequential FIRE age</div>
        <div class="jp-cal">${p2CalYear != null ? `${p2CalYear} · ${p2YearsToFull} yrs` : 'Not reached'}</div>
      </div>
    </div>
    <div class="joint-outcome">
      <div class="jo-row">
        <span class="jo-label">First sequential retirement</span>
        <span class="jo-val">${firstYear ? `${firstLabel} — ${firstYear} (age ${firstAge})` : 'Not reached'}</span>
      </div>
      ${gapYears != null && gapYears > 0 ? `<div class="jo-row">
        <span class="jo-label">Sequential retirement gap</span>
        <span class="jo-val">${gapYears} year${gapYears !== 1 ? 's' : ''} between sequential milestones</span>
      </div>` : ''}
      <div class="jo-row highlight">
        <span class="jo-label">Both retired (combined wealth)</span>
        <span class="jo-val">${hhCalYear ? `${hhCalYear} · your age ${hhFull} (${hhYearsToFull} yrs)` : 'Not reached by 90'}</span>
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
  const baseRes = _lastResult;
  if (!inp || !baseRes) return;
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

  const depleteNote = testRes.failed
    ? `<div class="whatif-box" style="border-color:var(--lean-border)">
        <div class="wb-label">Portfolio Survival</div>
        <div class="wb-val wb-delta-bad">Runs dry at ${testRes.depleteAge}</div>
        <div class="wb-sub">insufficient funds to age 90</div>
      </div>`
    : '';

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
    ${depleteNote}
  `;
};

function renderOptimisations(inp, result) {
  const el = document.getElementById('opt-grid');
  if (!el) return;
  const opts = [];

  const baseW90 = result.totalsReal[result.totalsReal.length - 1] || 0;
  const baseAllTax = (result.rows[0]?.annualTax.total || 0) + (result.rows[0]?.invTax || 0) + (result.rows[0]?.superTax || 0);
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

  // 2. Max Concessional Super (Primary) — accounts for MSCB, TSB < $500k carry-forward, 15% super tax & bridge survival
  const p1SG = Math.min(inp.grossSalary, MAX_SG_BASE) * inp.sgRate;
  const p1EligCF = inp.superBalance < CARRY_FWD_TSB_LIMIT ? inp.carryForwardCap : 0;
  const p1MaxSac = Math.max(0, Math.min(inp.grossSalary, CONCESSIONAL_CAP - p1SG + p1EligCF));
  const p1CapRoom = Math.max(0, p1MaxSac - inp.extraConcessional);
  if (p1CapRoom > 1000 && inp.grossSalary > 45000) {
    const maxConcInp = { ...inp, extraConcessional: inp.extraConcessional + p1CapRoom };
    const maxConcRes = project(maxConcInp);
    const mcW90 = maxConcRes.totalsReal[maxConcRes.totalsReal.length - 1] || 0;
    const mcAllTax = (maxConcRes.rows[0]?.annualTax.total || 0) + (maxConcRes.rows[0]?.invTax || 0) + (maxConcRes.rows[0]?.superTax || 0);
    const netTaxSaved = baseAllTax - mcAllTax;
    if (netTaxSaved > 0 && mcW90 > baseW90 && (!maxConcRes.failed || result.failed)) {
      addOpt('📈', 'Max Salary Sacrifice', `Add ${fmt(p1CapRoom)}/yr to pre-tax super to use remaining concessional cap.`, `Save ${fmt(netTaxSaved)} net tax/yr`);
    }
  }

  // 2b. Partner Max Concessional Super (Couple mode)
  if (inp.couple && inp.partnerSalary > 45000) {
    const p2SG = Math.min(inp.partnerSalary, MAX_SG_BASE) * inp.sgRate;
    const p2EligCF = inp.partnerSuperBalance < CARRY_FWD_TSB_LIMIT ? inp.partnerCarryForwardCap : 0;
    const p2MaxSac = Math.max(0, Math.min(inp.partnerSalary, CONCESSIONAL_CAP - p2SG + p2EligCF));
    const p2CapRoom = Math.max(0, p2MaxSac - inp.partnerExtraConcessional);
    if (p2CapRoom > 1000) {
      const pMaxInp = { ...inp, partnerExtraConcessional: inp.partnerExtraConcessional + p2CapRoom };
      const pMaxRes = project(pMaxInp);
      const pmcW90 = pMaxRes.totalsReal[pMaxRes.totalsReal.length - 1] || 0;
      const pmcAllTax = (pMaxRes.rows[0]?.annualTax.total || 0) + (pMaxRes.rows[0]?.invTax || 0) + (pMaxRes.rows[0]?.superTax || 0);
      const netTaxSaved = baseAllTax - pmcAllTax;
      if (netTaxSaved > 0 && pmcW90 > baseW90 && (!pMaxRes.failed || result.failed)) {
        addOpt('📈', 'Max Partner Salary Sacrifice', `Partner can add ${fmt(p2CapRoom)}/yr to pre-tax super within the concessional cap.`, `Save ${fmt(netTaxSaved)} net tax/yr`);
      }
    }
  }

  // 3. Tax-Smart Investments
  if (inp.couple && inp.investHolder !== 'lower' && (inp.investBalance > 0 || inp.cashBalance > 0 || inp.partnerInvestBalance > 0)) {
    const lowerInp = { ...inp, investHolder: 'lower' };
    const lowerRes = project(lowerInp);
    const lTax = (lowerRes.rows[0]?.annualTax.total || 0) + (lowerRes.rows[0]?.invTax || 0) + (lowerRes.rows[0]?.superTax || 0);
    const taxSaved = baseAllTax - lTax;
    if (taxSaved > 0) {
      addOpt('⚖️', 'Tax-Smart Investments', 'Switch taxable investments to the lower earner\'s name to reduce ongoing tax drag.', `Save ${fmt(taxSaved)} tax this yr`);
    }
  }

  // 4. Safer Withdrawal Rate
  if (inp.swr > 0.035) {
    const saferInp = { ...inp, swr: 0.035 };
    const saferRes = project(saferInp);
    const saferAge = saferRes.milestones.fullAge;
    const impactStr = saferAge == null
      ? 'Not reached by 90'
      : (() => {
          const diff = saferAge - (baseFull || saferAge);
          return diff > 0 ? `Retire ${diff} yr${diff !== 1 ? 's' : ''} later` : 'No delay in FIRE age';
        })();
    addOpt('🛡️', 'Conservative 3.5% SWR', `Lower withdrawal rate to 3.5% for more safety against sequence of returns risk.`, impactStr, 'gap', 'sc-red');
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

function renderScenarios(inp, p1Res, p2Res, baseRes) {
  const el = document.getElementById('scenario-grid');
  const introEl = document.getElementById('scenario-intro');
  if (!el) return;

  const scCard2 = (icon, title, sub, isReady, badgeLabel, rows, footer) => `
    <div class="sc-card ${isReady ? 'ready' : 'gap'}">
      <div class="sc-head">
        <div class="sc-icon">${icon}</div>
        <div class="sc-titlewrap">
          <div class="sc-title">${title}</div>
          <div class="sc-sub">${sub}</div>
        </div>
        <div class="sc-badge sc-badge-${isReady ? 'ready' : 'gap'}">${badgeLabel}</div>
      </div>
      <div class="sc-body">
        ${rows.map(([l, v, cls]) =>
          `<div class="sc-row${cls ? ' ' + cls : ''}"><span>${l}</span><span>${v}</span></div>`
        ).join('')}
      </div>
      ${footer ? `<div class="sc-foot">${footer}</div>` : ''}
    </div>`;

  // Single-person alternate scenarios
  if (!inp.couple || !p1Res || !p2Res) {
    if (introEl) introEl.textContent = 'Simulate different decisions (like retiring immediately or coasting) to see if the portfolio survives to age 90.';
    const baseW90 = baseRes?.totalsReal?.[baseRes.totalsReal.length - 1] ?? 0;
    const p1NetNoSac = calcTax(inp.grossSalary, 0, inp.hecsActive, taxOpts(inp)).net;
    const scenarios = [
      {
        icon: '🏖️', title: 'Retire immediately', sub: `Stop work now at age ${inp.currentAge}`,
        run: project({ ...inp, retirementAge: inp.currentAge }),
      },
      {
        icon: '⛵', title: 'Coast from today', sub: `Zero voluntary savings/sacrifice to age ${inp.retirementAge}`,
        run: project({
          ...inp, extraConcessional: 0, extraNonConcessional: 0,
          currentExpenses: Math.max(inp.currentExpenses, p1NetNoSac),
        }),
      },
      {
        icon: '⏩', title: 'Retire 5 years earlier', sub: `Target age ${Math.max(inp.currentAge + 1, inp.retirementAge - 5)} instead of ${inp.retirementAge}`,
        run: project({ ...inp, retirementAge: Math.max(inp.currentAge + 1, inp.retirementAge - 5) }),
      },
      {
        icon: '📈', title: '+10% retirement spending', sub: `Stress-test ${fmt(inp.fullExpenses * 1.1)}/yr retirement budget`,
        run: project({
          ...inp,
          leanExpenses: inp.leanExpenses * 1.1,
          baristaExpenses: inp.baristaExpenses * 1.1,
          fullExpenses: inp.fullExpenses * 1.1,
        }),
      },
    ];
    el.innerHTML = scenarios.map(sc => {
      const w90 = sc.run.totalsReal[sc.run.totalsReal.length - 1] ?? 0;
      const delta = w90 - baseW90;
      const ok = !sc.run.failed;
      const badgeLbl = ok ? '✓ Survives to 90' : `⚠ Dry at ${sc.run.depleteAge}`;
      const rows = [
        ['Wealth at age 90', fmtK(w90), ok ? 'sc-green' : 'sc-red'],
        ['vs base plan at 90', (delta >= 0 ? '+' : '') + fmtK(delta), delta >= 0 ? 'sc-green' : 'sc-red'],
        ['Full FIRE age', sc.run.milestones.fullAge ?? '90+', ''],
      ];
      const foot = ok
        ? `Plan remains funded through age 90 with ${fmtK(w90)} remaining.`
        : `Portfolio depletes at age ${sc.run.depleteAge} under these assumptions.`;
      return scCard2(sc.icon, sc.title, sc.sub, ok, badgeLbl, rows, foot);
    }).join('');
    return;
  }

  if (introEl) introEl.textContent = 'Each card shows one sequential retirement scenario: one partner retires while the other keeps working, so only the retiring partner needs to fund the household expense gap (not the full FI number).';

  const p1SG = Math.min(inp.grossSalary, MAX_SG_BASE) * inp.sgRate;
  const p2SG = Math.min(inp.partnerSalary, MAX_SG_BASE) * inp.sgRate;
  const p1EligCF = inp.superBalance < CARRY_FWD_TSB_LIMIT ? inp.carryForwardCap : 0;
  const p2EligCF = inp.partnerSuperBalance < CARRY_FWD_TSB_LIMIT ? inp.partnerCarryForwardCap : 0;
  const p1Sac = Math.max(0, Math.min(inp.extraConcessional, inp.grossSalary, Math.max(0, CONCESSIONAL_CAP - p1SG) + p1EligCF));
  const p2Sac = Math.max(0, Math.min(inp.partnerExtraConcessional, inp.partnerSalary, Math.max(0, CONCESSIONAL_CAP - p2SG) + p2EligCF));
  const p1TaxNow = calcTax(inp.grossSalary, p1Sac, inp.hecsActive, taxOpts(inp));
  const p2TaxNow = calcTax(inp.partnerSalary, p2Sac, inp.partnerHecsActive, taxOpts(inp));
  const p1Net = p1TaxNow.net + (p1TaxNow.hecs - Math.min(p1TaxNow.hecs, inp.hecsActive ? inp.hecsBalance : 0));
  const p2Net = p2TaxNow.net + (p2TaxNow.hecs - Math.min(p2TaxNow.hecs, inp.partnerHecsActive ? inp.partnerHecsBalance : 0));

  // Effective full expenses at each relevant age (houseBuyAge is on primary's age axis)
  const p2RetireInPrimaryAge = inp.currentAge + (inp.partnerRetirementAge - inp.partnerAge);
  const effExpNow      = houseExpAdjAt(inp, inp.currentAge);      // SC1/SC2: today
  const effExpP1Retire = houseExpAdjAt(inp, inp.retirementAge);   // SC3: your retirement age
  const effExpP2Retire = houseExpAdjAt(inp, p2RetireInPrimaryAge);// SC4: partner retirement (primary's age)

  const seqIfPartnerRetiresNow    = Math.max(0, effExpNow      - p1Net) / inp.swr;
  const seqIfYouRetireNow         = Math.max(0, effExpNow      - p2Net) / inp.swr;
  const seqIfYouRetireAtTarget    = Math.max(0, effExpP1Retire - p2Net) / inp.swr;
  const seqIfPartnerRetiresTarget = Math.max(0, effExpP2Retire - p1Net) / inp.swr;

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

  const isReady = (have, need) => (need <= 0 || have >= need);
  const blabel  = (have, need) => {
    if (need <= 0) return '✓ Ready now';
    if (have >= need) return '✓ On track';
    return Math.round(have / need * 100) + '% funded';
  };

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
    scCard2('👫', 'Partner retires now', 'You keep working to age ' + inp.retirementAge, isReady(p2Accessible, seqIfPartnerRetires), blabel(p2Accessible, seqIfPartnerRetires), sc1Rows, sc1Footer) +
    scCard2('🧑', 'You retire now', 'Partner keeps working to age ' + inp.partnerRetirementAge, isReady(p1Accessible, seqIfYouRetire), blabel(p1Accessible, seqIfYouRetire), sc2Rows, sc2Footer) +
    scCard2('🎯', 'You retire at ' + inp.retirementAge, 'Partner works to ' + inp.partnerRetirementAge, isReady(p1WealthAtTarget ?? 0, sc3Need), blabel(p1WealthAtTarget ?? 0, sc3Need), sc3Rows, sc3Footer) +
    scCard2('🎯', 'Partner retires at ' + inp.partnerRetirementAge, 'You work to ' + inp.retirementAge, isReady(p2WealthAtTarget ?? 0, sc4Need), blabel(p2WealthAtTarget ?? 0, sc4Need), sc4Rows, sc4Footer);
}

// ══════════════════════════════════════════════════════════
//  YEAR-BY-YEAR TABLE
// ══════════════════════════════════════════════════════════

function renderYearTable(rows, couple) {
  const el = document.getElementById('year-table');
  if (!el) return;
  const f = n => n > 0.5 ? fmt(n) : '—';
  const body = rows.map(r => {
    const basePhase = r.retired
      ? (r.householdNet > 0 ? '🏖+💼 Partner working' : '🏖 Both retired')
      : '💼 Working';
    const houseTag = r.mortgageActive ? ' · 🏠 mortgage'
      : (r.isHouseOwned ? ' · 🏠 owned' : '');
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
      <td>${f(r.mortgageRepaymentReal)}</td>
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
        <th>Saved</th><th>→ Super</th><th>Pension</th><th>Mortgage</th><th>Drawdown</th>
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
let _lastInp           = null;
let _lastResult        = null;
let _lastMc            = null;
let _lastPartnerResult = null;
let _lastPrimaryResult = null;

function calc() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(_calc, 80);
}

function _calc() {
  const inp = getInputs();

  if (inp.retirementAge <= inp.currentAge) {
    const rEl = document.getElementById('retirementAge');
    rEl.value = inp.currentAge + 1;
    inp.retirementAge = inp.currentAge + 1;
    syncRange(rEl, 'lbl-retire', '', '');
  }
  if (inp.couple && inp.partnerRetirementAge <= inp.partnerAge) {
    const el = document.getElementById('partnerRetirementAge');
    if (el) {
      el.value = inp.partnerAge + 1;
      inp.partnerRetirementAge = inp.partnerAge + 1;
      syncRange(el, 'lbl-partner-retire', '', '');
    }
  }

  updateCoupleUI(inp.couple);

  _lastInp = inp;

  const p1SG    = Math.min(inp.grossSalary, MAX_SG_BASE) * inp.sgRate;
  const p2SG    = Math.min(inp.partnerSalary, MAX_SG_BASE) * inp.sgRate;
  const capRoom = Math.max(0, CONCESSIONAL_CAP - p1SG);
  const p1EligCF = inp.superBalance < CARRY_FWD_TSB_LIMIT ? inp.carryForwardCap : 0;
  const p2EligCF = inp.partnerSuperBalance < CARRY_FWD_TSB_LIMIT ? inp.partnerCarryForwardCap : 0;

  document.getElementById('cap-warning').classList.toggle('show',
    inp.extraConcessional > capRoom + p1EligCF || inp.extraConcessional > inp.grossSalary);
  const pCapW = document.getElementById('p-cap-warning');
  if (pCapW) pCapW.classList.toggle('show',
    inp.couple && (inp.partnerExtraConcessional > Math.max(0, CONCESSIONAL_CAP - p2SG) + p2EligCF || inp.partnerExtraConcessional > inp.partnerSalary));

  const p1SacNow = Math.max(0, Math.min(inp.extraConcessional, inp.grossSalary, capRoom + p1EligCF));
  const p2SacNow = Math.max(0, Math.min(inp.partnerExtraConcessional, inp.partnerSalary, Math.max(0, CONCESSIONAL_CAP - p2SG) + p2EligCF));
  const p1TaxY0 = calcTax(inp.grossSalary, p1SacNow, inp.hecsActive, taxOpts(inp));
  const p2TaxY0 = calcTax(inp.partnerSalary, p2SacNow, inp.partnerHecsActive, taxOpts(inp));
  const p1RepayY0 = Math.min(p1TaxY0.hecs, inp.hecsActive ? inp.hecsBalance : 0);
  const p2RepayY0 = Math.min(p2TaxY0.hecs, inp.partnerHecsActive ? inp.partnerHecsBalance : 0);
  const p1NetNow = p1TaxY0.net + (p1TaxY0.hecs - p1RepayY0);
  const p2NetNow = p2TaxY0.net + (p2TaxY0.hecs - p2RepayY0);

  const result             = project(inp);
  const mc                 = runMonteCarlo(inp);
  const partnerResult      = inp.couple ? projectPartner(inp, p1NetNow) : null;
  const primaryResult      = inp.couple ? projectPrimary(inp, p2NetNow) : null;
  _lastRows          = result.rows;
  _lastResult        = result;
  _lastMc            = mc;
  _lastPartnerResult = partnerResult;
  _lastPrimaryResult = primaryResult;

  // Mortgage repayment hint — uses the actual simulated payoff age
  const mortgageHint = document.getElementById('mortgage-repayment-hint');
  if (mortgageHint) {
    const repay = annualMortgageRepayment(inp.mortgageAmount, inp.mortgageRate, inp.mortgageTerm);
    const active = inp.houseDeposit > 0 || inp.mortgageAmount > 0;
    if (active && repay > 0) {
      const effBuy = Math.max(inp.currentAge, inp.houseBuyAge);
      const paidAge = result.milestones.mortgagePaidAge ?? (effBuy + inp.mortgageTerm);
      const extraNote = inp.extraRepaymentPct > 0 ? ` (with ${(inp.extraRepaymentPct * 100).toFixed(0)}% extra repayments)` : '';
      mortgageHint.textContent = `Annual repayment: ${fmt(repay)}/yr (${fmt(repay / 12)}/mo) · mortgage-free at age ${paidAge}${extraNote}`;
      mortgageHint.style.display = 'block';
    } else {
      mortgageHint.style.display = 'none';
    }
  }

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
     <span style="font-size:10px;color:var(--text-muted)">Target grows as part-time years shorten · ${getSuperNote(baristaD.age)}</span>`,
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
      const houseAdj = row ? (row.houseExpAdj ?? 0) : 0;
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

    const pCoastTgt = pRows[0]?.coastNow ?? coastTarget(pt.fiEff, inp.partnerRetirementAge - inp.partnerAge,
      (1 + inp.investReturn) / (1 + inp.inflation) - 1);
    const pCoastCheckW = inp.partnerRetirementAge >= PRESERVATION_AGE ? pTotal : pAccessible;
    const pCoastProgress = pCoastTgt > 0 ? (pCoastCheckW / pCoastTgt) * 100 : 100;

    const pNoteFn = (age) => `<span style="font-size:10px;color:var(--text-muted)">Partner's individual wealth covering the gap while you work · ${pSuperNoteFn(age)}</span>`;

    const pLeanD = getPartnerCardData(pm.leanAge, 'leanTgt', pt.leanFIEff, inp.leanExpenses);
    renderCard('p-lean', pm.leanAge, inp.partnerAge, pLeanD.targetVal,
      `Household lean spend ${fmt(pLeanD.gap + p1NetNow)}/yr${houseExpNoteFn(pLeanD.houseAdj)} minus your net salary (${fmt(p1NetNow)}/yr) = ${fmt(pLeanD.gap)}/yr gap<br>
       ${pNoteFn(pLeanD.age)}`,
      pLeanD.progress);

    renderCard('p-coast', pm.coastAge, inp.partnerAge, pCoastTgt,
      `Partner's wealth coasts to the ${fmtK(pt.fiEff)} sequential gap target by ${inp.partnerRetirementAge}<br>
       <span style="font-size:10px;color:var(--text-muted)">${inp.partnerRetirementAge >= PRESERVATION_AGE ? "Partner's super + partner's own investments" : 'Liquid assets bridge to age 60 — super compounds untouched'}</span>`,
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

    renderJointSummary(inp, primaryResult?.milestones ?? milestones, pm, milestones);
  }

  renderScenarios(inp, primaryResult ?? result, partnerResult, result);
  renderWhatIf(inp, result);
  renderOptimisations(inp, result);

  // ── TAX STRIP (primary earner tax + household savings) ──
  const p1TaxNow = { ...p1TaxY0, net: p1NetNow, hecs: p1RepayY0 };
  const p1TaxTotal  = (p1TaxNow.raw || 0) + p1RepayY0;
  const totalGross  = inp.grossSalary + inp.partnerSalary;
  const savingsRate = totalGross > 0 ? currentSavings / totalGross * 100 : 0;

  const taxStripNote = document.getElementById('tax-strip-note');
  if (taxStripNote) taxStripNote.textContent = inp.couple ? 'your tax & pay · household annual savings' : 'your figures';
  const taxChartSub = document.getElementById('tax-chart-sub');
  if (taxChartSub) taxChartSub.textContent = inp.couple ? "Where your gross salary goes — your figures only, not your partner's" : 'Where your gross salary goes';

  const taxLabelEl = document.querySelector('#ts-tax')?.previousElementSibling;
  if (taxLabelEl) taxLabelEl.textContent = p1RepayY0 > 0 ? 'Tax + Medicare + HECS' : 'Income Tax + Medicare';
  const saveLabelEl = document.querySelector('#ts-save')?.previousElementSibling;
  if (saveLabelEl) saveLabelEl.textContent = inp.couple ? 'Household Savings' : 'Annual Savings';

  document.getElementById('ts-gross').textContent   = fmt(inp.grossSalary);
  document.getElementById('ts-tax').textContent     = fmt(p1TaxTotal);
  document.getElementById('ts-taxrate').textContent = pct(p1TaxTotal / Math.max(1, inp.grossSalary)) + ' eff.';
  document.getElementById('ts-take').textContent    = fmt(p1TaxNow.net || 0);
  document.getElementById('ts-weekly').textContent  = fmt(Math.round((p1TaxNow.net || 0) / 52)) + '/wk';
  document.getElementById('ts-sg').textContent      = fmt(p1SG + p1SacNow);
  document.getElementById('ts-cap').textContent     = fmt(Math.max(0, capRoom + p1EligCF - p1SacNow));
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
  buildTaxChart(p1TaxNow, inp.grossSalary, p1SG, p1SacNow);
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
  if (parseInt(ret.value, 10) <= v) ret.value = v + 5;
  syncRange(ret, 'lbl-retire', '', '');
});

document.getElementById('partnerAge')?.addEventListener('input', function () {
  const v   = parseInt(this.value, 10);
  const ret = document.getElementById('partnerRetirementAge');
  if (!ret) return;
  ret.min = v + 1;
  if (parseInt(ret.value, 10) <= v) ret.value = v + 5;
  syncRange(ret, 'lbl-partner-retire', '', '');
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
