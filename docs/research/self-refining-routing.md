# How a self-refining grouping of tickets onto Cells is learned elsewhere (issue #4151, map #4118)

## Question

Which established mechanisms learn a grouping of cases, each group served by one
action, and refine it as outcomes arrive? For each: how it forms, splits or merges
groups, or maps a context to an action; how it explores; what data it needs; whether
its output reads as rules a reviewer can diff; whether a fit reproduces from a
committed record; how it takes a constraint and two objectives; and how it copes with
non-stationarity. Measure and report; no ruling.

## Scale judged against

From the ticket brief (measured 2026-11-01 at origin/main e5040b9a; **not re-read
from the repo here** — this note is literature, and the worktree base is 24d29a4e):

- 300–5,000 Pulls a year; 3–15 Cells (the actions); cost coefficient of variation
  (CV) near 0.6; fail rates 20–55%; a quality floor "refuse an action whose failure
  rate is 15+ points above the baseline's"; two Objectives ($ and minutes); a reset
  whenever a model changes.
- The repo's 268 Pulls were drawn at random over 3 Cells (every Pull carries an
  `exploration_draw`): slow-high 104 (20 failed), task-high 104 (28 failed), smol-high
  32 (18 failed); $/Pull mean (sd) 14.51 (10.06), 10.28 (6.16), 11.06 (7.04); CV 0.693,
  0.599, 0.637 (derive § 8).
- Recorded pre-dispatch features: nine (`brief_chars`, `criteria`, `comments`,
  `age_days`, `paths`, `test_paths`, `xrefs`, `kind`, `parent`); two are categorical.

Every figure labelled "derive §n" is printed by
`node docs/research/self-refining-routing-derive.mjs`. They are closed-form
sample-size calculations on the brief's constants, not Router measurements. Anything I
did not read in a source or compute is marked **[INFERENCE]**.

## What was read

Primary sources were read as full text (arXiv PDFs, PMLR, the authors' own PDFs, the
packages' reference pages) except where noted: the CVFDT paper's PDF text would not
extract, so its claims rest on the ACM record and the River documentation that
implements its descendant (flagged below); the Seibold–Zeileis–Hothorn MOB subgroup
paper was read at abstract level only (CrossRef record). No blog summaries are cited.

---

## 1. Policy learning and policy trees

**Sources:** Athey & Wager, "Policy Learning with Observational Data"
([arXiv:1702.02896](https://arxiv.org/abs/1702.02896), Econometrica 2021); Zhou, Athey
& Wager, "Offline Multi-Action Policy Learning"
([arXiv:1810.04778](https://arxiv.org/abs/1810.04778), Operations Research 2023);
`policytree` docs ([package page](https://grf-labs.github.io/policytree/),
[`policy_tree()`](https://grf-labs.github.io/policytree/reference/policy_tree.html)).

1. **Groups / mapping.** The user fixes a policy class Π — "linear decision rules or
   finite-depth decision trees" — and the method picks the member maximising the sum of
   per-unit doubly robust scores, π̂ ∈ argmax Σ(2π(Xᵢ)−1)Γ̂ᵢ
   ([A&W §1, eq. 2](https://arxiv.org/abs/1702.02896)); the multi-action form
   maximises Σ Γᵢ(π(Xᵢ)) over depth-k trees
   ([policytree](https://grf-labs.github.io/policytree/)). `policy_tree()` "finds the
   optimal … depth k tree by exhaustive search"; "if the optimal action is the same in
   both the left and right leaf of a node, the node is pruned"
   ([reference](https://grf-labs.github.io/policytree/reference/policy_tree.html)). So
   a leaf is a group, its action is the argmax-reward action, depth is chosen by the
   analyst, and merging happens only by that pruning. Three steps: estimate nuisances,
   form cross-fitted DR scores Γ̂ᵢ, optimise over Π
   ([A&W §5](https://arxiv.org/abs/1702.02896)). The optimisation is batch, not online.
2. **Exploration.** None. It is offline learning from logged data; Zhou et al. state
   why: "online policy learning may be difficult or impossible as decision rules may
   need to be stable over time … Medical treatment guidelines may need peer or
   scientific review"
   ([arXiv:1810.04778 §1.1](https://arxiv.org/abs/1810.04778)). Identification needs
   overlap — an η>0 with |gₙ(x,z)| ≤ η⁻¹ for all x, z (Assumption 4,
   [A&W](https://arxiv.org/abs/1702.02896)) — which a randomised draw provides
   by construction. **[INFERENCE]** An action never drawn has no score column, so a
   new Cell needs draws before it can enter the tree.
3. **Data needs.** Regret R(π̂) = O_P(√(VC(Π)/n)), asymptotic, minimax-rate; VC of
   depth-L trees over p features is Õ(2^L log p)
   ([A&W §1, §3](https://arxiv.org/abs/1702.02896)); the multi-action analysis keeps
   O_P(1/√n) with unknown propensities and cites a matching Ω_P(1/√n) lower bound
   ([Zhou et al.](https://arxiv.org/abs/1810.04778)). No constant is given. In their
   simulation with a sharp-jump effect the learned depth-2 trees show "something of a
   phase transition between n = 2,000 and n = 4,000"
   ([A&W §5](https://arxiv.org/abs/1702.02896)); their empirical depth-1 tree
   splits 9,693 + 9,477 units ([Fig. 1](https://arxiv.org/abs/1702.02896)). Exact
   search costs O(pᵏnᵏ(log n + d) + pn log n); "a depth two tree scales quadratically
   with the number of observations"
   ([reference](https://grf-labs.github.io/policytree/reference/policy_tree.html)).
   **[INFERENCE]** at 300 Pulls the √(1/n) factor is 4.1× the 5,000-Pull one (derive
   § 6). A balanced depth-2 tree over 3 Cells leaves 22 Pulls per (leaf, Cell) at 268
   Pulls and needs 876 Pulls for 73 per cell, the brief's 30%-$ power figure
   (derive § 2). The exact-search term for K=15, n=5,000, k=2 is ~950× the repo's
   present size, k=3 at n=1,000, d=9 is ~2.3×10⁵× (derive § 7); `split.step` and
   `min.node.size` bound it
   ([reference](https://grf-labs.github.io/policytree/reference/policy_tree.html)).
4. **Readable as rules.** Yes: the printed object is a list of
   `split_variable`/`split_value`/`action` lines
   ([package page](https://grf-labs.github.io/policytree/)). A&W also argue the class
   encodes "simplicity, or other functional form constraints"
   ([abstract](https://arxiv.org/abs/1702.02896)). Their GAIN depth-2 tree is nested yes/no tests on
   individual characteristics ([Fig. 1](https://arxiv.org/abs/1702.02896)).
5. **Reproducible.** The tree search is exhaustive with deterministic output up to ties
   ("if this optimization problem has multiple solutions, we set π̂ to an arbitrary
   maximizer", [A&W fn. 4](https://arxiv.org/abs/1702.02896)). The scores come from a
   `grf` forest whose `seed` defaults to `runif(1, 0, .Machine$integer.max)` and whose
   `num.threads` defaults to the hardware maximum
   ([grf reference](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html)).
   **[INFERENCE]** Commit seed + cross-fit folds + score matrix (or use scores built from
   the known draw probability with a fixed outcome model) to reproduce.
6. **Constraint; two objectives.** Costs enter by shifting the reward column: the docs
   subtract an estimated effect from the treated column ("take cost of treatment into
   account")
   ([reference example](https://grf-labs.github.io/policytree/reference/policy_tree.html));
   A&W §5.1 includes linear costs. Budget and fairness constraints are said to be
   encoded in Π ([A&W §1](https://arxiv.org/abs/1702.02896)). No chance-constraint on a
   second outcome is given in these sources. **[INFERENCE]** A floor could be imposed
   by an extra score column or penalty, or by a feasible-action mask, then
   re-checked with the evaluator in § 8; a two-objective trade-off becomes a scalarised
   Γ (weighted sum). Neither is a documented feature.
7. **Non-stationarity.** The theory takes i.i.d. samples "(Xᵢ, Yᵢ, Wᵢ, Zᵢ)"
   ([A&W §2](https://arxiv.org/abs/1702.02896)); drift is not treated. **[INFERENCE]**
   A model change is a new distribution: refit on post-change Pulls (or down-weight
   old ones); Cell columns whose model changed restart at zero data.

## 2. Model-based recursive partitioning (MOB)

**Sources:** Zeileis, Hothorn & Hornik, "Model-Based Recursive Partitioning", JCGS 2008
([PDF](https://www.zeileis.org/papers/Zeileis+Hothorn+Hornik-2008.pdf)); partykit
vignette ([PDF](https://cran.r-project.org/web/packages/partykit/vignettes/mob.pdf));
Seibold, Zeileis & Hothorn, "MOB for Subgroup Analyses", Int J Biostat 2016
([doi](https://doi.org/10.1515/ijb-2015-0032), abstract only).

1. **Groups / mapping.** Four steps: "(1) fit a parametric model to a data set, (2)
   test for parameter instability over a set of partitioning variables, (3) if there is
   some overall parameter instability, split the model with respect to the variable
   associated with the highest instability, (4) repeat the procedure in each of the
   daughter nodes" ([Zeileis 2008 abstract](https://www.zeileis.org/papers/Zeileis+Hothorn+Hornik-2008.pdf)).
   Splits are binary in the paper's implementation; the stop rule is "no more
   significant parameter instability (by default at level α = 0.05)" plus `minsize` and
   `maxdepth`, with optional BIC post-pruning
   ([vignette](https://cran.r-project.org/web/packages/partykit/vignettes/mob.pdf)).
   Seibold et al. apply it to a treatment-effect model: the tree is "linked to
   predictive factors" with "differential treatment parameters corresponding to each
   patient subgroup" ([abstract](https://doi.org/10.1515/ijb-2015-0032)).
   **[INFERENCE]** For Cells the node model would be per-Cell mean cost and fail rate
   (a Cell factor), so a split says "the Cell ranking differs here"; the action in
   each leaf is then picked from that leaf's fitted per-Cell means.
2. **Exploration.** None; the tree is fitted to data already collected.
3. **Data needs.** No sample-size or power statement is made in the sources read; the
   knobs are α, `minsize`, `maxdepth`. The vignette warns "for very large sample size
   traditional significance levels are typically not useful because even tiny parameter
   instabilities can be detected" and advises smaller α or pruning
   ([vignette](https://cran.r-project.org/web/packages/partykit/vignettes/mob.pdf)). The
   Bonferroni-corrected minimum p-value over the partitioning variables is the split
   test ([Zeileis 2008 §3](https://www.zeileis.org/papers/Zeileis+Hothorn+Hornik-2008.pdf)).
   **[INFERENCE]** The converse holds at small n: the instability tests lose power
   (the brief's per-Cell 73/163 Pulls apply to each leaf; derive § 1), so at hundreds of
   Pulls the tree will mostly stay a single leaf.
4. **Readable as rules.** Yes: the model is a tree whose nodes carry thresholds;
   verbose mode prints each node's per-variable instability statistics and p-values,
   the "Best splitting variable" and "Selected split: <= 18 | > 18"
   ([vignette §Journals example](https://cran.r-project.org/web/packages/partykit/vignettes/mob.pdf)).
   Interpretability is one of the paper's stated aims
   ([Zeileis 2008 §1](https://www.zeileis.org/papers/Zeileis+Hothorn+Hornik-2008.pdf)).
5. **Reproducible.** The steps contain no random draw
   ([Zeileis 2008 §3](https://www.zeileis.org/papers/Zeileis+Hothorn+Hornik-2008.pdf));
   **[INFERENCE]** a fit is a deterministic function of the data frame and the
   control settings, so the committed Pulls plus α/`minsize`/`maxdepth` reproduce it.
6. **Constraint; two objectives.** The node model has one objective function used for
   both estimation and partitioning
   ([Zeileis 2008 §1](https://www.zeileis.org/papers/Zeileis+Hothorn+Hornik-2008.pdf)).
   Nothing in the sources addresses a floor or a second objective. **[INFERENCE]** A
   multivariate node model or one tree per objective, then a post-hoc filter.
7. **Non-stationarity.** MOB is the parametric descendant of structural-change testing
   (keywords "change points … parameter instability",
   [abstract](https://www.zeileis.org/papers/Zeileis+Hothorn+Hornik-2008.pdf)).
   **[INFERENCE]** Putting model-generation or time in the partitioning variables lets
   the instability test itself find the model change; not tested here.

## 3. Hoeffding trees / VFDT (and its drift-adaptive descendants)

**Sources:** Domingos & Hulten, "Mining High-Speed Data Streams", KDD 2000
([PDF](https://homes.cs.washington.edu/~pedrod/papers/kdd00.pdf)); Hulten, Spencer &
Domingos, CVFDT, KDD 2001 ([ACM](https://dl.acm.org/doi/10.1145/502512.502529); PDF
text did not extract, abstract-level only); River's
[`HoeffdingAdaptiveTreeClassifier`](https://riverml.xyz/latest/api/tree/HoeffdingAdaptiveTreeClassifier/).

1. **Groups / mapping.** A tree grown one example at a time: at a leaf, once the best
   attribute's score exceeds the second best's by more than ε, split. "Hoeffding bound
   … with probability 1−δ the true mean is at least r̄−ε, where ε = √(R² ln(1/δ)/2n)";
   it "is independent of the probability distribution generating the observations"
   but conservative ([VFDT §2](https://homes.cs.washington.edu/~pedrod/papers/kdd00.pdf)).
   Splits only: leaves become internal nodes; a "null attribute" gives pre-pruning. Ties
   are broken by splitting anyway when ΔG < ε < τ. VFDT is a *classifier* — label y is
   given. **[INFERENCE]** Routing needs a label per Pull (best Cell) or a regression
   variant; the bound assumes a bounded range R, which unbounded $/Pull lacks.
2. **Exploration.** None; it learns from labelled examples that arrive. Exploration
   must come from how the stream is generated (here, the random draw).
3. **Data needs.** VFDT was run with δ = 10⁻⁷, τ = 5%, n_min = 200; "C4.5 is more
   accurate than VFDT up to 25k examples" and VFDT gains only after 100k examples
   ([VFDT §4](https://homes.cs.washington.edu/~pedrod/papers/kdd00.pdf)). n_min is "a
   minimum number of new examples … accumulated at a leaf before G is recomputed";
   River's defaults keep `grace_period=200`, `delta=1e-07`, `tau=0.05`
   ([River](https://riverml.xyz/latest/api/tree/HoeffdingAdaptiveTreeClassifier/)).
   **[INFERENCE]** With R=1 (a rate) ε is 0.173 at n=268 for δ=10⁻⁷ (0.075 for δ=0.05);
   a gap of 15 points needs 359 Pulls *at one leaf* at δ=10⁻⁷ (67 at δ=0.05)
   (derive § 3). A 200-example grace period exceeds a low-end year (300) several-fold
   per leaf.
4. **Readable as rules.** Yes, a tree of attribute tests; River can `draw` it and
   `debug_one` prints the path for an input
   ([River](https://riverml.xyz/latest/api/tree/HoeffdingAdaptiveTreeClassifier/)).
5. **Reproducible.** Online and order-dependent: the tree depends on the order examples
   were seen **[INFERENCE]**. River's adaptive variant carries `seed` ("Random seed for
   reproducibility") and bootstrap sampling by default
   ([River](https://riverml.xyz/latest/api/tree/HoeffdingAdaptiveTreeClassifier/));
   replaying the committed Pull order with the same seed reproduces it **[INFERENCE]**.
6. **Constraint; two objectives.** Not addressed in the sources: a single split
   heuristic G on a label.
7. **Non-stationarity.** VFDT assumes a fixed concept. CVFDT's abstract claims accuracy
   comparable to re-running VFDT on a moving window at O(1) rather than O(w) per
   example ([ACM record](https://dl.acm.org/doi/10.1145/502512.502529), read via
   search summary); the adaptive variant grows "alternate" subtrees, switches at
   `switch_significance` = 0.05 after `drift_window_threshold` = 300 examples, using
   ADWIN by default
   ([River](https://riverml.xyz/latest/api/tree/HoeffdingAdaptiveTreeClassifier/)).

## 4. Contextual bandits

### 4a. LinUCB

**Sources:** Li, Chu, Langford & Schapire, WWW 2010
([arXiv:1003.0146](https://arxiv.org/abs/1003.0146)); Chu, Li, Reyzin & Schapire, AISTATS
2011 ([PMLR](https://proceedings.mlr.press/v15/chu11a/chu11a.pdf)).

1. **Groups / mapping.** No groups: each arm a has a linear payoff model E[r|x] = xᵀθ*ₐ;
   the arm with highest upper bound xᵀθ̂ₐ + α√(xᵀAₐ⁻¹x), α = 1+√(ln(2/δ)/2), is played
   ([Li §3.1, eq. 4–5](https://arxiv.org/abs/1003.0146)); "disjoint" means parameters
   are not shared across arms. The context→action map is a function of the features,
   not a partition.
2. **Exploration.** Optimism: the confidence-width term, "an additive trade-off between
   the payoff estimate and model uncertainty reduction"; the only parameter is α, "may
   be conservatively large … optimizing this parameter may result in higher total
   payoffs" ([Li §3.1](https://arxiv.org/abs/1003.0146)).
3. **Data needs.** Regret Õ(√(Td ln³(KT ln T/δ))) w.h.p. for T rounds, K actions, d
   features; lower bound Ω(√(Td)) ([Chu et al. abstract](https://proceedings.mlr.press/v15/chu11a/chu11a.pdf)).
   Evaluated on a Yahoo! dataset of "over 33 million events", with 12.5% click lift over
   a context-free bandit, "even greater when data gets more scarce"
   ([Li abstract](https://arxiv.org/abs/1003.0146)). **[INFERENCE]** Disjoint models
   fit K·d coefficients; with d = 9 metrics + intercept that is 30 (K=3) to 150 (K=15)
   coefficients against 268–5,000 Pulls: 8.9 down to 1.8 Pulls per coefficient at 268 (derive § 5).
4. **Readable as rules.** No: output is K coefficient vectors and a max over linear
   scores; a diff is a change in numbers, not a threshold. ADR 0016 already rejects
   this form (brief).
5. **Reproducible.** Deterministic: state is (Aₐ, bₐ) updated by rank-one sums; "ties
   broken arbitrarily" ([Algorithm 1](https://arxiv.org/abs/1003.0146)).
   **[INFERENCE]** Replaying the committed Pull order recomputes it exactly.
6. **Constraint; two objectives.** None in LinUCB. Related work: Conservative LinUCB
   "maintains its performance above a fixed percentage of the performance of a
   baseline strategy, uniformly over time" — Σrᵢ ≥ (1−α)Σr_baseline for all t, with a
   regret term that is "a constant (does not grow with the time horizon)"
   ([Kazerouni et al.](https://arxiv.org/abs/1611.06426)); for K-armed,
   an extra regret of order O(KL/αμ₀)
   ([Wu et al., Thm 2](https://proceedings.mlr.press/v48/wu16.pdf)). Those are
   *cumulative* constraints relative to a baseline, not a per-action filter. Multi-objective:
   see 4c.
7. **Non-stationarity.** "The algorithm works well for a dynamic arm set"
   ([Li §3.1](https://arxiv.org/abs/1003.0146)) — a new Cell starts with its own
   (A, b) = (I, 0). Drift itself is not treated in LinUCB. For abrupt changes,
   discounted and sliding-window UCB achieve regret O(√(Υ_T·T·log T)) for Υ_T
   breakpoints and match a lower bound up to log factors; "any policy … that
   achieves a logarithmic regret in the stationary case cannot reach a regret of
   order smaller than T/log T in presence of breakpoints"
   ([Garivier & Moulines](https://arxiv.org/abs/0805.3415)). Those are context-free;
   **[INFERENCE]** a contextual version is not in the source.

### 4b. Thompson sampling for contextual bandits

**Source:** Agrawal & Goyal, ICML 2013 ([arXiv:1209.3352](https://arxiv.org/abs/1209.3352)).

1. **Groups / mapping.** As LinUCB: linear model per context-arm; the choice is
   arg maxᵢ bᵢ(t)ᵀμ̃(t) after sampling μ̃ from N(μ̂(t), v²B(t)⁻¹)
   ([Algorithm 1](https://arxiv.org/abs/1209.3352)).
2. **Exploration.** Randomised posterior sampling; no explicit bonus.
3. **Data needs.** High-probability regret Õ(d^{3/2}√T), "within a factor of √d of the
   information-theoretic lower bound"; the contexts "provided by an adaptive
   adversary"; rewards R-sub-Gaussian
   ([abstract + §2.1](https://arxiv.org/abs/1209.3352)). Same scale as 4a with an extra √d.
4. **Readable as rules.** No (linear scores, randomised choice).
5. **Reproducible.** Each step draws a d-dimensional Gaussian sample
   ([Computational efficiency note](https://arxiv.org/abs/1209.3352)); **[INFERENCE]**
   reproducing a decision needs the RNG seed or the drawn values committed, and a
   logged propensity (for later off-policy use) is not produced unless estimated by
   Monte Carlo.
6. **Constraint; two objectives.** Not addressed.
7. **Non-stationarity.** Analysis assumes a stationary linear model
   ([§2.1](https://arxiv.org/abs/1209.3352)); drift not addressed.

### 4c. Contextual zooming / adaptive partitioning (the one that builds groups)

**Sources:** Slivkins, "Contextual Bandits with Similarity Information", COLT 2011, full
version revised May 2014 ([arXiv:0907.3986](https://arxiv.org/abs/0907.3986)); Turgay, Öner & Tekin,
"Multi-objective Contextual Bandit Problem with Similarity Information", AISTATS 2018
([arXiv:1803.04015](https://arxiv.org/abs/1803.04015)).

1. **Groups / mapping.** The algorithm "maintains a finite collection 𝒜ₜ of balls …
   which collectively cover the similarity space"; "initially there is only one active
   ball which has radius 1 and therefore contains the entire similarity space"; adding
   balls is "activating" and "balls stay active once they are activated"; a ball
   becomes a *parent* when its confidence radius ≤ its radius
   ([Slivkins §4.2–4.3](https://arxiv.org/abs/0907.3986)). So it refines (splits) and
   never merges; regions are metric balls over context × arm. "The central idea is to
   maintain a finer partition in high-payoff regions of the similarity space and in
   popular regions of the context space" ([abstract](https://arxiv.org/abs/0907.3986)).
   It requires a known Lipschitz similarity distance on context-arm pairs
   ([§1](https://arxiv.org/abs/0907.3986)). **[INFERENCE]** That means choosing a
   metric over brief_chars, paths, kind, parent… before any data arrives.
2. **Exploration.** Index-based (optimistic) selection of a ball and arm by a
   "selection rule"; activation by an "activation rule"
   ([§4.2](https://arxiv.org/abs/0907.3986)).
3. **Data needs.** Worst case R(T) ≤ O(T^{1−1/(2+d_X+d_Y)} log T) for the uniform
   partition; the adaptive algorithm matches it in the worst case and beats it with
   the "contextual zooming dimension" d_c
   ([§1, Thm 4.1](https://arxiv.org/abs/0907.3986)). "Each active ball must be played
   at least r⁻² times before it becomes a parent ball" (§4.2 proof), so a radius-r cell
   costs ≥ r⁻² plays (up to a log factor): 4 at r = ½, 16 at r = ¼, 64 at r = ⅛.
   **[INFERENCE]** Payoffs are normalised to [0,1] in the paper; cost with CV 0.6
   would need rescaling, and the r⁻² cost is *per ball per arm*.
4. **Readable as rules.** Partially: balls are regions with centres and radii;
   **[INFERENCE]** a diff is a list of new balls, which reads as rules only if the
   metric is axis-aligned thresholds.
5. **Reproducible.** **[INFERENCE]** Deterministic given the arrival order and the
   index tie rule (I did not read the tie rule); the partition is a function of the
   played sequence, so the played sequence is the record.
6. **Constraint; two objectives.** Pareto Contextual Zooming handles "multiple and
   possibly conflicting objectives" with a contextual Pareto regret and
   Õ(T^{(1+d_p)/(2+d_p)}) regret plus a matching lower bound
   ([Turgay et al. abstract](https://arxiv.org/abs/1803.04015)). It returns arms
   near the Pareto front, not a single arm. A per-action quality floor is not in the
   paper. Resource-type constraints exist for contextual bandits generally: "Bandits with
   Knapsacks" ([Badanidiyuru et al.](https://arxiv.org/abs/1305.2545)) and "Resourceful
   Contextual Bandits" ([Badanidiyuru, Langford & Slivkins](https://arxiv.org/abs/1402.6779)),
   whose constraints are on consumed resources in total.
7. **Non-stationarity.** "Writing xₜ = t one can incorporate 'temporal constraints'
   (across time, for each arm)" and sleeping bandits are subsumed
   ([§1](https://arxiv.org/abs/0907.3986)): drift that is Lipschitz in time, not abrupt
   resets. **[INFERENCE]** A reset is the sleeping case: the old Cell's balls go
   "asleep" and the new Cell starts with no active child balls.

## 5. Causal trees and forests for heterogeneous effects

**Sources:** Athey & Imbens, "Recursive Partitioning for Heterogeneous Causal Effects"
([arXiv:1504.01132](https://arxiv.org/abs/1504.01132)); Wager & Athey, "Estimation and
Inference of Heterogeneous Treatment Effects using Random Forests"
([arXiv:1510.04342](https://arxiv.org/abs/1510.04342)); `grf`
[`multi_arm_causal_forest`](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html).

1. **Groups / mapping.** Causal tree: a regression tree whose splitting criterion
   targets treatment-effect fit and variance, with "one sample … used to construct the
   partition and another to estimate treatment effects for each subpopulation"
   ("honest")
   ([A&I abstract](https://arxiv.org/abs/1504.01132)). Causal forest: the group is
   implicit, a kernel weighting from many honest trees; the output is τ̂(x) per
   context ([W&A](https://arxiv.org/abs/1510.04342)). Multi-arm forests estimate
   τ_k(x) = E[Y(k) − Y(1)|X=x] with a baseline arm
   ([grf](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html)).
   These estimate *effects*, not actions; an action is chosen by the sign/size of τ̂
   (and feeds § 1's scores).
2. **Exploration.** None (observational/experimental data in, estimates out);
   unconfoundedness or randomisation is required
   ([W&A abstract](https://arxiv.org/abs/1510.04342)).
3. **Data needs.** Honesty halves the data per step: "a loss of precision due to sample
   splitting" ([A&I §1](https://arxiv.org/abs/1504.01132)); grf defaults
   `sample.fraction=0.5`, `honesty.fraction=0.5`, `num.trees=2000`, `min.node.size=5`
   ([grf](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html)).
   W&A's asymptotic normality needs subsample size s ≍ nᵝ ([W&A §1](https://arxiv.org/abs/1510.04342));
   their heterogeneity experiment used n = 5,000 with subsample s = 2,500 (|I| = 1,250
   per honest half), a propensity experiment n = 500
   ([W&A §5](https://arxiv.org/abs/1510.04342)); grf's 3-arm example uses n = 500
   ([grf example](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html)).
   No minimum n is stated. **[INFERENCE]** 268 Pulls over 3 Cells is below the sizes
   the source uses; 5,000 matches its top end.
4. **Readable as rules.** A single causal tree: yes. A forest: no — "a nonparametric
   causal forest" yields predictions and a variance estimate, not thresholds
   ([W&A abstract](https://arxiv.org/abs/1510.04342)).
5. **Reproducible.** grf takes `seed`; its default is random and `num.threads` defaults
   to all cores
   ([grf](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html)).
   **[INFERENCE]** Committing the seed and thread setting is required.
6. **Constraint; two objectives.** The forest "can be estimated jointly" for multiple
   outcomes — the splitting rule "takes into account all outcomes simultaneously"
   ([grf details](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html)) —
   and gives confidence intervals (univariate Y only, per `ci.group.size`). **[INFERENCE]**
   A refuse-if-fail-rate-15-points-above rule reads off a per-Cell τ̂ for the fail
   indicator with its interval; the rule itself is not in the source.
7. **Non-stationarity.** i.i.d. sampling is assumed; no drift treatment. **[INFERENCE]**
   A Cell change = drop/reweight pre-change rows (`sample.weights` exists,
   [grf](https://grf-labs.github.io/grf/reference/multi_arm_causal_forest.html)).

## 6. Off-policy evaluation from logged randomised data

**Sources:** Dudík, Langford & Li, "Doubly Robust Policy Evaluation and Learning", ICML
2011 ([arXiv:1103.4601](https://arxiv.org/abs/1103.4601)); Li, Chu, Langford & Wang,
"Unbiased Offline Evaluation of Contextual-bandit-based News Article Recommendation"
([arXiv:1003.5956](https://arxiv.org/abs/1003.5956)); Swaminathan & Joachims, CRM
([arXiv:1502.02362](https://arxiv.org/abs/1502.02362)); Thomas, Theocharous &
Ghavamzadeh, "High Confidence Policy Improvement"
([PMLR 37](https://proceedings.mlr.press/v37/thomas15.html)).

1. **Groups / mapping.** None by itself: it *scores* a candidate policy (any
   context→action map, including a tree) on data collected under another policy.
   DR combines a reward model ρ̂ and the propensity model p̂: "this approach yields
   accurate value estimates when we have either a good … model of rewards or a good …
   model of past policy" ([abstract](https://arxiv.org/abs/1103.4601)). Dudík et al.
   also use DR scores for policy *optimisation* (the same scores as § 1).
2. **Exploration.** None; it consumes the exploration that was logged.
3. **Data needs.** Bias of DR = |E[Δδ]| with Δ the reward-model error and δ = 1 − p/p̂
   the propensity error; IPS = special case ρ̂ ≡ 0; DR variance has a randomness term, a
   context term and "the importance weighting penalty" E[(1−p)/p·Δ²(1−δ)²]
   ([Thm 1–2](https://arxiv.org/abs/1103.4601)). **[INFERENCE]** When the draw
   probability is logged and used as p̂, δ = 0 and DR is unbiased whatever the reward
   model; this is the repo's case. The replay evaluator for uniformly random logging
   gives an unbiased history of length T while consuming L events with E[L] = KT and
   L ≤ 2K(T + ln(1/δ)) w.p. ≥ 1−δ ([Thm 1](https://arxiv.org/abs/1003.5956)); so
   N logged Pulls yield T ≈ N/K: 89 at N=268, K=3; 30 at K=9; 18 at K=15 (derive
   § 4). CRM adds a variance-penalised bound for regularising a learner on logged
   propensity-weighted data ([abstract](https://arxiv.org/abs/1502.02362)).
4. **Readable as rules.** Not a policy form: it outputs value estimates and intervals
   for a policy that *is* readable.
5. **Reproducible.** Deterministic given the log and the recorded probabilities (replay
   uses no model, [Li et al.](https://arxiv.org/abs/1003.5956)). **[INFERENCE]** The
   committed `exploration_draw`s are exactly the record it needs.
6. **Constraint; two objectives.** Any outcome can be scored: replace the reward by the
   failure indicator or the minutes. High-confidence policy improvement accepts "any
   performance lower-bound and confidence level" and bounds the chance of returning a
   policy below it ([Thomas et al.](https://proceedings.mlr.press/v37/thomas15.html)):
   a policy-level (not per-action) floor with guaranteed confidence. **[INFERENCE]**
   The 15-point floor per action maps onto evaluating a candidate's failure rate vs the
   baseline's and rejecting if the interval's upper bound exceeds +15.
7. **Non-stationarity.** Theorem 1 of replay assumes i.i.d. events from a uniformly
   random logging policy ([Li et al.](https://arxiv.org/abs/1003.5956)); DR's bias
   result allows a history-dependent past policy h
   ([Dudík Thm 1](https://arxiv.org/abs/1103.4601)). Neither models a reward shift;
   **[INFERENCE]** a model change means evaluating on post-change events only.

---

## Comparison: mechanism × (1)–(7)

Scale: 300–5,000 Pulls/yr, 3–15 Cells, cost CV ≈ 0.6. "Pulls per leaf-Cell" and other
scale figures are **[INFERENCE]** from the derive script. `Src` = the source cited in
the section above.

| Mechanism | (1) Groups / mapping | (2) Explores? | (3) Data needs (source; implication at scale) | (4) Rules a reviewer can diff? | (5) Deterministic / reproducible from record? | (6) Constraint and two objectives | (7) Non-stationarity / Cell reset |
|---|---|---|---|---|---|---|---|
| **Policy tree** (A&W; `policytree`) | Exhaustive search of depth-k trees maximising Σ DR scores; prunes a node if both leaves pick one action; analyst fixes depth | No (offline; needs overlap) | Regret O_P(√(VC/n)), VC = Õ(2^L log p); sim. "phase transition" 2,000–4,000; runtime ∝ pᵏnᵏ. 22 Pulls/(leaf,Cell) at 268, K=3, L=2 | Yes: printed split/value/action | Search exact (ties arbitrary); scores from seeded `grf` forest. Commit seed + scores | Cost via shifting score column; constraints "encoded in Π"; no outcome-floor feature. Two objectives by scalarised Γ [INFERENCE] | i.i.d.; refit on post-change window [INFERENCE]; a new Cell has no score column |
| **MOB** (Zeileis 2008; partykit) | Fit model per node, test parameter instability over features, split on the most unstable (Bonferroni, α = .05), recurse; BIC prune | No | No sample-size claim; α, `minsize`, `maxdepth`; tests over-reject at huge n | Yes: nodes with thresholds, per-node p-values | No random step in the algorithm [INFERENCE]; data + α/minsize/maxdepth | Single objective; floor and 2nd objective not covered | Descends from change-point tests; model generation can be a partitioning variable [INFERENCE] |
| **Hoeffding tree / VFDT** (+ CVFDT/HAT) | Streaming splits when ΔG > ε = √(R² ln(1/δ)/2n); ties at τ; needs a label | No | δ=10⁻⁷, τ=.05, n_min=200; beats C4.5 only after ~25k–100k examples; ε=.173 at n=268, R=1; 359 per leaf for 15-pt gap | Yes: tree of tests | Order-dependent; HAT has `seed` | Not addressed | VFDT stationary; CVFDT/HAT grow alternate subtrees, ADWIN, switch at 0.05 after 300 examples |
| **LinUCB** (Li 2010; Chu 2011) | Per-arm linear model; no groups; arg max UCB | Yes: optimism, α | Õ(√(Td)), lower Ω(√(Td)); K·d = 30–150 coefficients vs 268–5,000 Pulls | No: coefficient vectors | Deterministic given history; ties arbitrary | None native; Conservative LinUCB: cumulative (1−α)·baseline; PCZ for objectives (4c) | Dynamic arm set OK; drift: D-/SW-UCB (context-free): O(√(Υ T log T)) |
| **Thompson, linear** (Agrawal & Goyal 2013) | As LinUCB; posterior sample | Yes: randomised | Õ(d^{3/2}√T); sub-Gaussian rewards | No | Needs seed / logged draws | Not addressed | Stationary assumption |
| **Contextual zooming** (Slivkins 2011/14; PCZ) | Adaptive cover of context×arm metric space; refine only, never merge; needs known similarity metric | Yes: index rule | Worst case T^{1−1/(2+d_X+d_Y)}; ≥ r⁻² plays to split a radius-r ball (16 at r=¼, 64 at r=⅛) | Partially: balls (centre, radius) | Deterministic given play sequence [INFERENCE] | PCZ: Pareto regret Õ(T^{(1+d_p)/(2+d_p)}); floor not covered; BwK/resourceful: total-resource constraints | Time as context (Lipschitz drift); sleeping arms |
| **Causal tree / forest** (A&I; W&A; `grf`) | Honest splitting for effect heterogeneity; forest gives τ̂(x), no explicit groups; multi-arm contrasts vs a baseline | No | Honest halves; n=5,000 and n=500 in sources; no minimum stated | Tree: yes; forest: no | Seed (default random) + threads | Multi-outcome joint forest; CIs for scalar Y; floor rule built on τ̂ [INFERENCE] | i.i.d.; `sample.weights` [INFERENCE] |
| **Off-policy evaluation** (Dudík 2011; replay; CRM; HCPI) | Scores a given policy on logged data; no groups | No (uses logged draws) | DR bias |E[Δδ]|=0 if p̂=p; replay uses ≈K events per history step (T≈N/K: 89 at 268, K=3) | n/a (evaluates a readable policy) | Yes: log + recorded probabilities | Any outcome scorable; HCPI: policy-level lower bound with confidence | i.i.d. replay; evaluate post-change events only [INFERENCE] |

## What was not measured

- No Router or repo figure was re-measured; the Cell table is the brief's.
- The brief's 73/163/286-Pull power figures are reproduced within two Pulls (derive § 1:
  74/165/287); the brief's own calculation is not given.
- I did not run any of these packages on the repo's Pulls.
- Constants hidden by O(·) bounds (A&W, Chu, Slivkins, Agrawal & Goyal) are not stated
  in the sources read; the scale rows above are orders, not predicted Pull counts.
- CVFDT's paper text and Seibold et al. beyond the abstract were not read in full.

## Reproduce

`node docs/research/self-refining-routing-derive.mjs` prints every "derive §n" figure
(Node ≥ 18, no dependencies, no network).
