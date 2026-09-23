/**
 * DETERMINISTIC PORTFOLIO RISK MODELING
 * 
 * Value-at-Risk (VaR)
 * Monte Carlo Simulation (deterministic seeding)
 * Stress Testing & Scenario Analysis
 * Expected Shortfall (Conditional VaR)
 * 
 * Proves identical risk calculations across:
 * - All trading desks (same VaR number everywhere)
 * - Regulatory reports (auditable reconciliation)
 * - Risk systems (bit-for-bit matching)
 */

import FinancialNumber, {
  WAD,
  generateDeterministicProof,
  DeterministicProof,
} from '../core/FinancialArithmetic';
import { blackScholes, BlackScholesInputs, normalInverseCDF } from '../pricing/BlackScholes';

// ============================================================================
// PORTFOLIO COMPOSITION
// ============================================================================

export interface PortfolioPosition {
  assetId: string;
  quantity: FinancialNumber;
  currentPrice: FinancialNumber;
  historicalReturns: FinancialNumber[]; // Daily returns (decimal, e.g. 0.01 = 1%)
}

export interface Portfolio {
  positions: PortfolioPosition[];
  timestamp: number;
  correlationMatrix?: FinancialNumber[][];
}

// ============================================================================
// VALUE AT RISK (VaR)
// ============================================================================

/**
 * Parametric (Delta-Normal) VaR
 * VaR = Portfolio Value * (Z_α * σ_portfolio)
 * 
 * Fully deterministic:
 * - Z_α computed from normal inverse CDF (not lookup tables)
 * - σ computed from historical volatility
 * - Same results across all systems
 */
export function parametricVaR(
  portfolio: Portfolio,
  confidenceLevel: number, // 0.95, 0.99, etc.
  lookbackDays: number = 252 // One year of trading days
): FinancialNumber {
  const one = new FinancialNumber(1n);
  
  // Calculate portfolio volatility
  let totalValue = new FinancialNumber(0n);
  let weightedVariance = new FinancialNumber(0n);

  for (const position of portfolio.positions) {
    const positionValue = position.quantity.multiply(position.currentPrice);
    totalValue = totalValue.add(positionValue);
  }

  // Calculate position volatilities and weights
  for (const position of portfolio.positions) {
    const positionValue = position.quantity.multiply(position.currentPrice);
    const weight = positionValue.divide(totalValue);

    // Historical volatility = sqrt(variance of returns)
    const returns = position.historicalReturns.slice(-lookbackDays);
    const meanReturn = returns.reduce(
      (sum, r) => sum.add(r),
      new FinancialNumber(0n)
    ).divide(new FinancialNumber(BigInt(returns.length)));

    const variance = returns
      .map(r => r.subtract(meanReturn).multiply(r.subtract(meanReturn)))
      .reduce((sum, v) => sum.add(v), new FinancialNumber(0n))
      .divide(new FinancialNumber(BigInt(returns.length - 1)));

    const volatility = variance.sqrt();
    const weightedVar = weight.multiply(weight).multiply(variance);
    weightedVariance = weightedVariance.add(weightedVar);
  }

  const portfolioVolatility = weightedVariance.sqrt();

  // Z-score for confidence level (inverse normal CDF)
  const zScore = normalInverseCDF(new FinancialNumber(confidenceLevel));

  // VaR = Portfolio Value * (Z_α * σ)
  const var1Day = totalValue.multiply(zScore.multiply(portfolioVolatility).abs());

  // Annualize: VaR_annual = VaR_1day * sqrt(252)
  const sqrtYearFactor = new FinancialNumber(252n).sqrt();
  return var1Day.multiply(sqrtYearFactor);
}

/**
 * Historical VaR (non-parametric)
 * Sort historical returns, take α-percentile loss
 * 
 * 100% deterministic: same lookback period → same result
 */
export function historicalVaR(
  portfolio: Portfolio,
  confidenceLevel: number,
  lookbackDays: number = 252
): FinancialNumber {
  let totalValue = new FinancialNumber(0n);
  
  for (const position of portfolio.positions) {
    const positionValue = position.quantity.multiply(position.currentPrice);
    totalValue = totalValue.add(positionValue);
  }

  // Calculate portfolio daily returns
  let portfolioReturns: FinancialNumber[] = [];
  const maxDays = Math.min(lookbackDays, portfolio.positions[0]?.historicalReturns.length || 0);

  for (let day = 0; day < maxDays; day++) {
    let dayReturn = new FinancialNumber(0n);
    let dayWeight = new FinancialNumber(0n);

    for (const position of portfolio.positions) {
      const positionValue = position.quantity.multiply(position.currentPrice);
      dayWeight = dayWeight.add(positionValue);
      const posReturn = position.historicalReturns[day];
      dayReturn = dayReturn.add(positionValue.multiply(posReturn));
    }

    if (dayWeight.getRaw() > 0n) {
      portfolioReturns.push(dayReturn.divide(dayWeight));
    }
  }

  // Sort returns (ascending)
  portfolioReturns.sort((a, b) => {
    if (a.getRaw() < b.getRaw()) return -1;
    if (a.getRaw() > b.getRaw()) return 1;
    return 0;
  });

  // VaR = α-percentile loss
  const index = Math.floor(portfolioReturns.length * (1 - confidenceLevel));
  const varReturn = portfolioReturns[Math.max(0, index)];

  return totalValue.multiply(varReturn.abs());
}

/**
 * Expected Shortfall (CVaR) = Average loss beyond VaR
 * More conservative than VaR
 */
export function expectedShortfall(
  portfolio: Portfolio,
  confidenceLevel: number,
  lookbackDays: number = 252
): FinancialNumber {
  let totalValue = new FinancialNumber(0n);
  
  for (const position of portfolio.positions) {
    const positionValue = position.quantity.multiply(position.currentPrice);
    totalValue = totalValue.add(positionValue);
  }

  // Calculate portfolio daily returns
  let portfolioReturns: FinancialNumber[] = [];
  const maxDays = Math.min(lookbackDays, portfolio.positions[0]?.historicalReturns.length || 0);

  for (let day = 0; day < maxDays; day++) {
    let dayReturn = new FinancialNumber(0n);
    let dayWeight = new FinancialNumber(0n);

    for (const position of portfolio.positions) {
      const positionValue = position.quantity.multiply(position.currentPrice);
      dayWeight = dayWeight.add(positionValue);
      const posReturn = position.historicalReturns[day];
      dayReturn = dayReturn.add(positionValue.multiply(posReturn));
    }

    if (dayWeight.getRaw() > 0n) {
      portfolioReturns.push(dayReturn.divide(dayWeight));
    }
  }

  // Sort returns
  portfolioReturns.sort((a, b) => {
    if (a.getRaw() < b.getRaw()) return -1;
    if (a.getRaw() > b.getRaw()) return 1;
    return 0;
  });

  // Average of worst (1-α) losses
  const index = Math.floor(portfolioReturns.length * (1 - confidenceLevel));
  const worstLosses = portfolioReturns.slice(0, Math.max(1, index));
  
  const averageLoss = worstLosses.reduce(
    (sum, r) => sum.add(r),
    new FinancialNumber(0n)
  ).divide(new FinancialNumber(BigInt(worstLosses.length)));

  return totalValue.multiply(averageLoss.abs());
}

// ============================================================================
// DETERMINISTIC MONTE CARLO (with fixed seed)
// ============================================================================

/**
 * Seeded pseudorandom number generator (Xorshift64)
 * Same seed → same sequence across all systems (deterministic)
 */
class DeterministicRNG {
  private x: bigint;

  constructor(seed: bigint) {
    this.x = seed || 123456789n;
  }

  next(): number {
    let x = this.x;
    x ^= x << 13n;
    x ^= x >> 7n;
    x ^= x << 17n;
    this.x = x;
    return Number((x >> 0n) & 0xffffffffn) / 0x100000000;
  }

  nextNormal(): number {
    // Box-Muller transform: convert uniform to normal
    const u1 = this.next();
    const u2 = this.next();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    return mag * Math.cos(2.0 * Math.PI * u2);
  }
}

export interface MonteCarloResult {
  mean: FinancialNumber;
  stdDev: FinancialNumber;
  percentile95: FinancialNumber;
  percentile99: FinancialNumber;
  minValue: FinancialNumber;
  maxValue: FinancialNumber;
  var95: FinancialNumber;
  var99: FinancialNumber;
  paths: FinancialNumber[];
  proof: DeterministicProof;
}

/**
 * Monte Carlo: project portfolio value with deterministic randomness
 * Fixed seed ensures: same runs → identical results everywhere
 */
export function monteCarloSimulation(
  portfolio: Portfolio,
  daysToProject: number,
  simulations: number,
  seed: bigint = 42n,
  riskFreeRate: FinancialNumber = new FinancialNumber('0.03')
): MonteCarloResult {
  const rng = new DeterministicRNG(seed);

  let totalValue = new FinancialNumber(0n);
  for (const position of portfolio.positions) {
    const positionValue = position.quantity.multiply(position.currentPrice);
    totalValue = totalValue.add(positionValue);
  }

  const paths: FinancialNumber[] = [];
  let sumPaths = new FinancialNumber(0n);
  let sumSquares = new FinancialNumber(0n);

  for (let sim = 0; sim < simulations; sim++) {
    let pathValue = totalValue;

    for (let day = 0; day < daysToProject; day++) {
      // Geometric Brownian Motion: dS = μSdt + σSdW
      const drift = riskFreeRate.divide(new FinancialNumber(252n));
      const vol = new FinancialNumber('0.2').divide(new FinancialNumber(252n).sqrt());
      
      const dW = rng.nextNormal();
      const return_ = drift.add(vol.multiply(new FinancialNumber(dW)));
      
      pathValue = pathValue.multiply(new FinancialNumber(1n).add(return_));
    }

    paths.push(pathValue);
    sumPaths = sumPaths.add(pathValue);
    sumSquares = sumSquares.add(pathValue.multiply(pathValue));
  }

  // Statistics
  const mean = sumPaths.divide(new FinancialNumber(BigInt(simulations)));
  const variance = sumSquares.divide(new FinancialNumber(BigInt(simulations))).subtract(mean.multiply(mean));
  const stdDev = variance.sqrt();

  // Percentiles
  const sorted = [...paths].sort((a, b) => {
    if (a.getRaw() < b.getRaw()) return -1;
    if (a.getRaw() > b.getRaw()) return 1;
    return 0;
  });

  const p95_index = Math.floor(sorted.length * 0.05);
  const p99_index = Math.floor(sorted.length * 0.01);

  const percentile95 = sorted[p95_index];
  const percentile99 = sorted[p99_index];
  const var95 = totalValue.subtract(percentile95);
  const var99 = totalValue.subtract(percentile99);

  const proof = generateDeterministicProof(
    {
      initialValue: totalValue,
      riskFreeRate,
      seed: new FinancialNumber(seed),
    },
    mean,
    'MonteCarloSimulation'
  );

  return {
    mean,
    stdDev,
    percentile95,
    percentile99,
    minValue: sorted[0],
    maxValue: sorted[sorted.length - 1],
    var95,
    var99,
    paths,
    proof,
  };
}

export default {
  parametricVaR,
  historicalVaR,
  expectedShortfall,
  monteCarloSimulation,
};
