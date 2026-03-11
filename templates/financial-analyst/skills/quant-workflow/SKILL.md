---
name: quant-workflow
description: Quantitative finance workflow best practices — portfolio optimization, risk modeling, econometrics, and backtesting
---

# Quantitative Finance Workflow Skill

## Description

Best practices for quantitative finance research workflows. This skill provides **workflow guidance** on how to use workspace tools effectively for financial analysis tasks.

## Portfolio Analysis Workflow

### When to use
User asks to analyze, construct, or optimize a portfolio.

### Recommended flow
1. **Plan** — `update_tasks` to outline analysis steps
2. **Load data** — `jupyter_execute` with pandas/yfinance to fetch price data
3. **Analyze** — Calculate returns, volatility, Sharpe ratio, max drawdown
4. **Optimize** — Run mean-variance, Black-Litterman, or risk parity optimization
5. **Visualize** — Plot efficient frontier, cumulative returns, drawdowns via `update_gallery`
6. **Report** — `update_notes` with findings, or `latex_project` for formal paper

### Key principles
- Always check data quality (missing values, survivorship bias)
- Report both in-sample and out-of-sample performance
- Include transaction costs and slippage in backtests
- Use walk-forward analysis, not just single backtest

## Risk Modeling Workflow

### When to use
User asks to model risk, calculate VaR/CVaR, or run stress tests.

### Recommended flow
1. **Plan** — `update_tasks`
2. **Data** — Load returns data, check for fat tails and autocorrelation
3. **Model** — Fit appropriate distribution (normal, t-dist, GARCH) via `jupyter_execute`
4. **Estimate** — Calculate VaR, CVaR at desired confidence levels
5. **Stress test** — Run historical and hypothetical scenarios
6. **Report** — Tables and charts via `update_gallery` + `update_notes`

### Key principles
- Normal distribution underestimates tail risk — prefer t-distribution or GARCH
- Always backtest VaR models (Kupiec test, Christoffersen test)
- Report multiple risk metrics, not just VaR
- Include stress test scenarios (2008 crisis, COVID, rate shocks)

## Econometrics Workflow

### When to use
User asks to estimate models, test hypotheses, or analyze time series.

### Recommended flow
1. **Specify** — Define model and hypotheses clearly
2. **Test assumptions** — Stationarity (ADF), normality, heteroscedasticity
3. **Estimate** — OLS, GLS, GMM, or panel data methods via `jupyter_execute`
4. **Diagnose** — Check residuals, multicollinearity, endogeneity
5. **Report** — Regression tables with standard errors, R-squared, diagnostics

### Key principles
- Always test for stationarity before time series modeling
- Use robust standard errors (Newey-West, clustered) for inference
- Distinguish between correlation and causation
- Report economic significance alongside statistical significance

## General Best Practices

1. **Always start with `update_tasks`** — multi-step analysis needs visible progress
2. **Data quality first** — garbage in, garbage out
3. **Out-of-sample validation** — in-sample results are not evidence
4. **Assumptions matter** — state them explicitly, test them empirically
5. **Compile LaTeX after writing** — formal reports should produce a PDF
