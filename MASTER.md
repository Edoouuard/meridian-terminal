# Meridian — Master document

> **Ce fichier est ma feuille de route (Claude) et la source de vérité du projet.** À chaque session : lire ce fichier, reprendre la première case non cochée de la phase en cours, la livrer avec sa preuve, cocher la case dans la même PR. Ne rien construire qui ne soit pas dans la phase en cours.
>
> Dernière mise à jour : 2026-10-15 · Phase en cours : **Phase 0 — Ouvrir la bêta privée**
>
> Légende : **[moi]** = je le code et le livre · **[toi]** = action du propriétaire (wallet, comptes, décisions) · chaque case dit sa **preuve** (test, hash de transaction, capture, log).

---

## 1. Vision

**Meridian est un terminal agentique pour toute la finance : tu décris ce que tu veux en langage naturel, Meridian comprend ton patrimoine, trouve la meilleure exécution et la fait signer en sécurité — puis, dans les limites que tu fixes, la surveille et agit pour toi.**

Le chemin, par ordre de friction croissante :
1. **Aujourd'hui** : DeFi « prompt-to-trade » — 8 chaînes EVM + Hyperliquid, prêt, staking, vaults, taux fixe, bridges, perps.
2. **Ensuite** : un agent — il surveille le portefeuille et agit selon des mandats (clés de session bornées, révocables).
3. **Ensuite** : toute la finance — TradFi tokenisée on-chain, puis lecture et exécution TradFi via des partenaires régulés.

### Pour qui
Un utilisateur DeFi équipé d'un wallet, qui gère de quelques milliers à quelques centaines de milliers de dollars sur plusieurs chaînes et en a assez de jongler entre dix interfaces. Plus tard : toute personne qui veut piloter crypto et patrimoine traditionnel au même endroit.

### La promesse
1. **Comprendre** : l'intention devient un plan clair (quoi, où, combien, pourquoi), dimensionné sur le solde libre réel.
2. **Comparer** : données live (prix, APY, TVL, risque, coût de bridge), meilleure route.
3. **Exécuter sans risque** : Meridian ne détient jamais tes fonds, ne fait jamais confiance à une adresse venant d'un LLM ou d'une API, simule avant de signer.
4. **Suivre et agir** : le portefeuille se met à jour, les stratégies sont suivies, l'agent alerte puis agit dans son mandat.

### Non-objectifs
- Pas de custody : aucune clé utilisateur côté serveur (une clé de session bornée en Phase 3 sera une décision explicite, voir D7).
- Pas de nouvelle surface (chaîne, protocole, venue) tant que les parcours existants ne sont pas prouvés en réel.

---

## 2. État réel (2026-10-15)

| Brique | État | Preuve / manque |
|---|---|---|
| Planner IA (`/api/parse-intent`, OpenRouter Gemini Flash) | ✅ prod, 3 stratégies, taux live (cookie bêta transmis, PR #35), dimensionné sur le solde libre (`budgetFit`) | Pas de jeu d'évaluation : qualité non mesurée |
| Validateur déterministe (`strategyIntegrity`, `fundingPlanner`, `budgetFit`) | ✅ 441 tests | — |
| Portefeuille (8 chaînes EVM + compte Hyperliquid) | ✅ soldes, Aave, donut d'allocation, prix de tous les jetons suivis | Positions Morpho, Pendle, Spark Savings, Fluid, Yearn, EigenLayer non lues |
| Exécution spot (Aave, Morpho, Spark, Fluid, Yearn, Sky, Ethena, Lido, EigenLayer, Pendle, Uniswap, wrap WETH) | 🟡 prouvée sur forks en CI | Aucune transaction réelle confirmée par protocole |
| Bridges (deBridge, LI.FI) | 🟡 prouvés sur fork Arbitrum | Aucun bridge réel de bout en bout |
| Hyperliquid (dépôt, perps avec SL/TP, vente spot UETH/UBTC, retrait) | 🟡 signature identique au SDK officiel (vecteurs testés) ; retrait vers Compound confirmé par le propriétaire | Perps jamais exécutés sur un vrai compte |
| Perps Extended | 🟡 connexion wallet + ordres prouvés sur testnet | Jamais exécuté sur mainnet |
| Perps Ondo, Lighter | 🟡 codés, activés en prod | Jamais exécutés en réel |
| Bêta (mot de passe, bug report `/api/feedback`, Sentry, `[exec-log]`, WalletConnect si configuré) | ✅ | WalletConnect à configurer ; aucun testeur |
| TradFi | ❌ absent (hors perps Ondo) | — |

**En une phrase : la planification marche, l'exécution est construite et prouvée sur forks, mais presque rien n'a été prouvé avec un vrai wallet. C'est le seul vrai écart avant la bêta.**

---

## 3. Architecture

### 3.1 Vue d'ensemble

```
┌──────────────────────────── Navigateur (Next.js client) ────────────────────────────┐
│                                                                                      │
│  page.tsx  ── 3 colonnes : Portefeuille | Chat (ThreadCard) | News/Alpha             │
│     │                                                                                │
│     │ 1. intention texte                                                             │
│     ▼                                                                                │
│  intentEngine ──► POST /api/parse-intent (LLM) ──► TradePlan { legs[] }              │
│     │                     (repli : tradePlan.ts, règles locales)                     │
│     ▼                                                                                │
│  assetMap.resolveOrderForLeg ──► Order (protocole, token, montant, chainId)          │
│     │                                                                                │
│     ▼                                                                                │
│  ValidatedExecuteButton / useExecuteOrder ──► lib/orderRunner.ts                     │
│     DRAFT → VALIDATING → SIMULATING → READY_FOR_SIGNATURE → SIGNING → CONFIRMED      │
│     · adresses depuis onchain.ts / routerAllowlist.ts uniquement                     │
│     · allowance lue on-chain, approve du montant exact                               │
│     · simulation (eth_call) + garde-fou health factor (Aave MCP)                     │
│     ▼                                                                                │
│  wagmi / viem ──► wallet de l'utilisateur (signature) ──► chaîne                     │
│     │                                                                                │
│     ▼                                                                                │
│  useLivePortfolio (lectures on-chain) + history.ts (localStorage)                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
                 │ fetch /api/*  (proxy.ts : rate limit + mot de passe bêta)
┌────────────────▼──────────────── Serveur (routes API Next.js, Vercel) ───────────────┐
│  Données : /prices /yield /best-yield /alpha /chains /vault-risk /yield-context      │
│            /positions /stake-yield                                                   │
│  Routage : /bridge /route-quote ──► lib/mcp/router.ts (deBridge vs LI.FI)            │
│  Risque  : /preview-action ──► Aave MCP (simulation health factor)                   │
│  IA      : /parse-intent ──► OpenRouter                                              │
│  Statut  : /mcp (santé des MCP)                                                      │
└────────────────┬─────────────────────────────────────────────────────────────────────┘
                 ▼
  MCP (Streamable HTTP) : deBridge · LI.FI · Aave   (+ replis REST : DLN, li.quest, earn.li.fi)
  APIs : DefiLlama · CoinGecko · Morpho · Philidor · OpenRouter
```

### 3.2 Modules clés

| Couche | Fichiers | Rôle |
|---|---|---|
| UI | `app/page.tsx`, `components/ThreadCard.tsx`, `components/thread/*`, `components/execute/*`, `components/*Panel.tsx` | Terminal 3 colonnes, fil de conversation, boutons d'exécution par venue, panneaux |
| Intent | `lib/intentEngine.ts`, `app/api/parse-intent`, `lib/tradePlan.ts` | Texte → `TradePlan` |
| Résolution | `lib/assetMap.ts`, `lib/quote.ts` | `TradeLeg` → `Order` (montants exacts, prix live) |
| Exécution | `lib/execution.ts`, `lib/executionPlan.ts`, `lib/orderRunner.ts`, `hooks/useExecuteOrder.ts`, `hooks/useStrategyExecutor.ts`, `components/ValidatedExecuteButton.tsx`, `components/ConfirmDialog.tsx` | `Order` → transaction validée, simulée, signée |
| Sécurité | `lib/onchain.ts`, `lib/mcp/routerAllowlist.ts`, `lib/safety.ts` | Allowlist d'adresses, garde-fou HF |
| Routage | `lib/mcp/router.ts`, `lib/mcp/{debridge,lifi}.ts` | Devis comparés, tx de bridge/swap |
| MCP | `lib/mcp/client.ts`, `lib/mcp/aave.ts` | Client MCP robuste (timeouts, coercition, replis) |
| Protocoles | `lib/protocols/registry.ts`, `lib/protocols/vaults.ts`, `lib/protocols/opportunities.ts`, `app/api/opportunities` | Couverture DefiLlama (slug → nom, catégorie, exécutable ou comparaison), vaults ERC-4626 vérifiés, classement des meilleurs rendements |
| Portefeuille | `hooks/useLivePortfolio.ts`, `app/api/positions` | Soldes et positions on-chain |
| Infra | `proxy.ts`, `lib/rateLimit.ts`, `lib/betaGate.ts`, `lib/features.ts` | Rate limit, accès bêta, feature flags |

### 3.3 Invariants de sécurité (non négociables)

1. **Aucune adresse de contrat ne vient d'un LLM ou d'une API.** Les cibles de transaction viennent de `onchain.ts` (protocoles) ou `routerAllowlist.ts` (routeurs LI.FI Diamond / deBridge DlnSource).
2. **Approbations au montant exact**, jamais illimitées ; allowance lue on-chain avant.
3. **Simulation avant signature.** Une simulation qui échoue bloque.
4. **Health factor** : tout borrow/withdraw Aave simulé ; refus sous 1,10.
5. **Meridian ne signe jamais** : le serveur ne détient aucune clé.
6. **Un seul chemin d'exécution** : tout ordre wallet passe par `lib/orderRunner.ts` (via `useExecuteOrder` ou `useStrategyExecutor`). Seuls les perps et le spot Hyperliquid ont leur propre chemin : Hyperliquid signe avec une clé de trading générée dans le navigateur et approuvée une fois par le wallet (`lib/integrations/hyperliquidTrade.ts`, elle peut trader, jamais retirer) ; Extended (StarkEx, clé Stark dérivée d'une signature du wallet, appels via le relais `/api/extended` faute de CORS) et Ondo/Lighter (LI.FI Perps) ont leur signature propre.
7. **Budget** : aucune stratégie ne demande plus de capital frais que le solde libre (`lib/budgetFit.ts`, appliqué côté serveur après le LLM).

### 3.4 Configuration (Vercel)

| Variable | Rôle | État |
|---|---|---|
| `OPENROUTER_API_KEY` | Chat IA | production + preview |
| `BETA_PASSWORD` | Accès bêta | présent (sensible, production) ; `NEXT_PUBLIC_BETA_PASSWORD` obsolète, à supprimer |
| `LIFI_API_KEY` | Coffres earn LI.FI + quotas LI.FI | présente (sensible, production + preview) |
| `BLOB_READ_WRITE_TOKEN` | Stockage | présent |
| `NEXT_PUBLIC_SENTRY_DSN` | Suivi d'erreurs + journal des exécutions dans Sentry | présent |
| `NEXT_PUBLIC_ALCHEMY_API_KEY` / `NEXT_PUBLIC_INFURA_API_KEY` | RPC dédiés (`lib/rpc.ts` : URL explicite `NEXT_PUBLIC_RPC_<CHAIN>` → Alchemy → Infura → publics) | présents ; restreints aux domaines Meridian côté fournisseur |
| `NEXT_PUBLIC_FEATURE_PERPS` | Venues perps (Hyperliquid, Extended, Ondo, Lighter) | `1` en prod (demande du propriétaire) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Wallets mobiles (WalletConnect / Reown) | **à créer** (gratuit, cloud.reown.com) |

### 3.5 Hyperliquid

- **HyperEVM (chaîne 999)** : 8e chaîne active. Jetons suivis (USDT0, USDe, WHYPE, UETH, UBTC — symbole et décimales vérifiés on-chain), solde natif HYPE, RPC officiel, bridges entrants/sortants via LI.FI (diamond propre à HyperEVM, `0x0a07…ce1A`, confirmé par l'API LI.FI et on-chain) et deBridge (DlnSource, id interne 100000022). Un stable USD bridgé vers HyperEVM arrive en USDT0.
- **Dépôt Hyperliquid exécutable** : USDC natif d'Arbitrum → Bridge2 officiel (`0x2Df1…3dF7`, ~400 M$ USDC), crédité sur le compte Hyperliquid en ~1 min. Garde-fous dans le builder : USDC Arbitrum uniquement, minimum 5 USDC (en dessous, perdu). Prouvé sur fork Arbitrum en CI.
- **Portefeuille** : le compte Hyperliquid réel (mainnet, lecture seule) — marge perps, soldes spot, part HLP — s'ajoute aux avoirs. Avant : lu sur le testnet, donc jamais vu.
- **Trading** : perps (IOC au marché, levier) et vente spot UETH/UBTC signés par une clé de trading approuvée une fois par le wallet (`hyperliquidExchange.ts` vérifié contre le SDK Python officiel, `hyperliquidTrade.ts`) ; UETH sur HyperEVM transféré vers l'adresse système HyperCore avant la vente. **Jamais exécuté en réel (Phase 0.1).**
- **Pas encore exécutable** : dépôt HLP, staking HYPE (renvoi vers l'app Hyperliquid).
- **Données** : HLP (APR live), écosystème HyperEVM via DefiLlama (« Hyperliquid L1 ») : HyperLend, Kinetiq, Felix en comparaison, onglet Yields « HYPE ».

### 3.6 Couverture des protocoles (DefiLlama)

- **Exécutables (intégration dédiée)** : Aave, Compound, Morpho, Spark (SparkLend), Lido, Rocket Pool, Pendle, EigenLayer.
- **Exécutables (vaults ERC-4626 vérifiés, un seul chemin de signature)** : Fluid (fUSDC/fUSDT/fWETH sur Ethereum, Arbitrum, Base), Sky sUSDS (Ethereum), Spark Savings sUSDC (Ethereum, Base, Arbitrum), Ethena sUSDe (Ethereum, sortie en 7 jours). Chaque vault : `asset()` vérifié on-chain avant ajout et à chaque audit, dépôt prouvé sur fork en CI.
- **Exécutables par swap Uniswap (pool WETH profond vérifié on-chain)** : ether.fi weETH (Base, Arbitrum), Kelp rsETH (Arbitrum, wrsETH sur Base), Renzo ezETH (Base).
- **Comparaison seulement** : Maple, cbETH, wBETH, StakeWise, mETH, Liquid Collective, Aave v4, Yearn, Curve LlamaLend, Venus, Lista, Dolomite, Euler, Silo, Benqi, Moonwell, Centrifuge.
- Onglet **Yields** (colonne droite) et contexte du planner : meilleurs rendements mono-actif ≥ 5 M$ de TVL sur les 7 chaînes, séparés « exécutable » / « comparaison ».
- Ajouter un protocole = une ligne dans `registry.ts` (et, pour un vault ERC-4626, une ligne vérifiée dans `vaults.ts`).

---

## 4. Roadmap

Règle : **une phase s'ouvre seulement quand la précédente a atteint son critère de sortie** (un chiffre mesuré, pas une date).

```
Phase 0  Ouvrir la bêta privée ........ semaines 1-2   porte : 10 testeurs · 30 tx réelles · 0 perte
Phase 1  Bêta fermée, fiabiliser ...... semaines 3-8   porte : 50 testeurs · >90 % tx confirmées · 30 % reviennent
Phase 2  Produit solide, bêta ouverte . mois 3-4       porte : 500 actifs/mois · revenu mesurable · audit OK
Phase 3  Terminal agentique ........... mois 4-7       porte : 20 % des actifs ont un mandat · 0 action hors mandat
Phase 4  Toute la finance (TradFi) .... mois 6-12      porte : crypto + tokenisé + courtier pilotés depuis Meridian
```

### Phase 0 — Ouvrir la bêta privée (en cours)

**Objectif : 10 testeurs de confiance passent une vraie transaction sans aide. On prouve et on réduit ; rien de nouveau.**

**0.1 Prouver chaque parcours en réel** (20-50 $ par parcours)
- [ ] [toi] Supply 20 USDC sur Aave (Base) depuis le planner → position visible. *Preuve : hash.*
- [ ] [toi] Bridge 10 USDC Arbitrum → Base, puis dépôt de l'étape suivante après arrivée. *Preuve : 2 hashes.*
- [ ] [toi] Stake 0,01 ETH sur Lido ; achat PT Pendle 20 USDC. *Preuve : hashes.*
- [ ] [toi] Wrap ETH → WETH ajouté automatiquement puis supply WETH. *Preuve : hashes.*
- [ ] [toi] Hyperliquid : dépôt 10 USDC, approbation de la clé de trading, short ETH 10 $ puis fermeture, vente UETH spot. *Preuve : hashes + fills affichés.*
- [ ] [toi] Hyperliquid → Compound/Fluid : « bridge mes stables de Hyperliquid vers le meilleur rendement » → retrait vers Arbitrum, bridge, dépôt. *Preuve : 3 étapes confirmées.*
- [ ] [moi] Corriger chaque blocage remonté, une PR par bug, avec le hash ou le log qui prouve le correctif.
- [ ] [moi] Tableau « parcours prouvés » dans ce fichier (§2) : protocole · chaîne · hash · date.

**0.2 Montrer seulement ce qui marche**
- [ ] [moi] Flags par venue dans `lib/features.ts` (`hlPerps`, `hlSpot`, `extended`, `ondo`, `lighter`), chacun piloté par sa variable `NEXT_PUBLIC_FEATURE_*`. *Preuve : tests unitaires des flags.*
- [ ] [moi] Une venue désactivée : absente du prompt du planner (`parse-intent`), du validateur et des boutons (`StrategyLegs` → `NotWired`). *Preuve : test qu'aucune stratégie ne la propose quand le flag est off.*
- [ ] [moi] Plafond par transaction en bêta (`NEXT_PUBLIC_BETA_MAX_TX_USD`, défaut 1 000 $) vérifié dans `orderRunner.prepareOrder` et les boutons Hyperliquid, message clair. *Preuve : test orderRunner refusant 1 001 $.*
- [ ] [toi] Décider quelles venues restent visibles (D1).

**0.3 Configuration de prod**
- [ ] [toi] `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (cloud.reown.com) puis redéploiement.
- [ ] [toi] Supprimer `NEXT_PUBLIC_BETA_PASSWORD` dans Vercel.
- [ ] [toi] Initialiser le pare-feu Vercel (onglet Firewall) ; [moi] poser les règles WAF prêtes (`/api/parse-intent` 15 req/min/IP, `/api/*` 300 req/min/IP).
- [ ] [toi] Alerte email Sentry sur les issues `Execution …`.

**0.4 Accueillir les testeurs**
- [ ] [moi] Page `/welcome` affichée une fois après la connexion bêta : ce que fait Meridian (3 lignes), 3 prompts à essayer, risques (vrais fonds, bêta, plafond), comment signaler un bug. *Preuve : capture desktop + mobile.*
- [ ] [moi] Lien « Report a bug » visible aussi sur mobile (barre du haut repliée). *Preuve : capture mobile.*
- [ ] [toi] Recruter 10 testeurs (DeFi actifs, 500-50 000 $, 2 chaînes ou plus) et ouvrir un groupe Telegram.

**0.5 Mesurer dès le premier jour**
- [ ] [moi] Persister `[exec-log]` et `[feedback]` dans Vercel Blob (un fichier JSONL par jour), en plus des logs. *Preuve : test de la route + fichier visible dans Blob.*
- [ ] [moi] Page `/admin` protégée (`ADMIN_PASSWORD`) : plans générés, tx signées / confirmées / échouées par protocole et par raison, rapports de bug, wallets actifs sur 7 jours. *Preuve : capture avec données réelles.*
- [ ] [moi] Journaliser chaque plan généré (`[plan-log]` : prompt tronqué, stratégies, budget, facteur d'échelle) pour l'évaluation de la Phase 1.

**Critère de sortie :** 10 testeurs actifs · ≥ 30 transactions réelles confirmées · aucune perte de fonds · chaque parcours visible a un hash de preuve.

### Piste prioritaire — Perps et protocoles (demandée le 2026-10-15)

**Objectif : chaque perp et chaque protocole proposé par le planner s'exécute de bout en bout depuis Meridian, avec les garde-fous d'un vrai terminal de trading.** Passe avant les cases [moi] de la Phase 0 hors bugs.

**P1 Perps Hyperliquid complets**
- [x] [moi] Bouton perp : marché, funding annualisé pour le côté choisi, marge libre (compte unifié inclus) contre la marge nécessaire, attente automatique du dépôt, transfert spot → perps en une signature. *Preuve : tests `hyperliquidTrade` (marge unifiée, funding).*
- [x] [moi] Stop-loss / take-profit réduits (ordres trigger) posés après le fill, au prix réel d'entrée ; désactivés par défaut sur un short qui couvre un spot. *Preuve : signature identique au SDK officiel (test `hyperliquidExchange`), test du flux ouverture → SL.*
- [x] [moi] Fermer la position depuis l'étape de la stratégie. 
- [x] [moi] Position neutre sur Hyperliquid avec l'argent déjà sur le compte : achat UETH au spot Hyperliquid (IOC signé par la clé de trading, transfert perps → spot en une signature sur un compte non unifié) + short ETH, dimensionnés pour tenir dans le solde du compte. *Preuve : tests `strategyIntegrity`, `budgetFit`, `planSpotBuy`.*
- [ ] [toi] Demander « beta neutral ETH sur Hyperliquid », acheter l'UETH puis ouvrir le short. *Preuve : UETH dans le solde spot + short dans Risk → Perp positions.*
- [ ] [toi] Ouvrir puis fermer un short ETH de 10 $ avec stop-loss sur mainnet. *Preuve : fills affichés + ordre SL visible dans l'app Hyperliquid.*
- [x] [moi] Ordres limite (GTC, post-only ALO) depuis l'étape perp ; ordres ouverts (limite, stop-loss, take-profit) listés dans le panneau Hyperliquid avec annulation et déplacement du prix. *Preuve : signatures cancel / batchModify identiques au SDK, tests `hyperliquidTrade` (limite au repos, minimum 10 $, annulation, lecture des triggers).*

**P2 Perps HIP-3 sur Hyperliquid (actions, indices, matières premières)**
- [x] [moi] Marchés des dex HIP-3 collatéralisés en USDC (`xyz` : 115 marchés — S&P 500, XYZ100, Nvidia, Tesla, or, pétrole… ; `para`, `io`) : identifiant d'actif `110000 + (slot − 1) × 10000 + index`, prix et funding par dex, levier isolé quand le marché l'impose, alias (SPX, NASDAQ, OIL, BRENT, XAU). Dex en USDH / USDe / USDT0 ignorés. *Preuve : vecteurs SDK (ordre à l'actif 110001, levier isolé, `agentEnableDexAbstraction`), tests de résolution et d'identifiants.*
- [x] [moi] Le planner reçoit les 40 marchés HIP-3 les plus échangés (prix, funding, levier max) et les propose (« short Tesla », « long or ») ; le bouton perp les exécute depuis le solde USDC principal (abstraction de dex activée une fois par la clé de trading, rien à faire pour un compte unifié) ; positions et ordres HIP-3 visibles dans le panneau Hyperliquid. *Preuve : tests `hyperliquidTrade` HIP-3, liste en direct vérifiée sur mainnet.*
- [ ] [toi] Ouvrir puis fermer un short `xyz:TSLA` de 10-15 $ (marge isolée 1-2x). *Preuve : fill affiché + position visible dans le panneau.*

**P3 Plus de protocoles exécutables**
- [ ] [moi] Vaults ERC-4626 vérifiés on-chain : Euler v2, Morpho (coffres supplémentaires), Yearn v3, Silo v2 — une ligne par vault dans `vaults.ts`, dépôt prouvé sur fork.
- [x] [moi] Restaking liquide par swap Uniswap, là où le pool WETH est profond (vérifié on-chain : 0,1 WETH coté à < 1 % du taux) : ether.fi weETH (Base, Arbitrum), Kelp rsETH (Arbitrum ; wrsETH sur Base), Renzo ezETH (Base). Ethereum exclu (pools trop minces). Jetons suivis dans le portefeuille et valorisés, protocoles exécutables dans le registre, planner informé. *Preuve : test fork `e2e/restaking.fork.test.ts` (achat de rsETH via orderRunner sur fork Arbitrum : 0,1 WETH → 0,0926 rsETH) ; routes Base (ezETH, wrsETH, weETH) vérifiées par cotations QuoterV2 en direct seulement — le fork Base de la CI se bloque sur ce test (à investiguer) ; tests registre / jetons.*
- [ ] [moi] Vaults Euler v2 / Silo v2 : DefiLlama n'en liste aucun ≥ 5 M$ en USDC/WETH sur Ethereum, Base ou Arbitrum (vérifié 2026-10-16) — à reprendre quand la liquidité y sera.
- [ ] [moi] Moonwell / Venus (forks Compound) sur Base et BNB.

**P4 Autres venues perps**
- [x] [moi] Extended : connexion par trois signatures du wallet (clé de trading Stark dérivée de la signature, compte ouvert ou retrouvé, clé API émise), plus de copier-coller de clés. L'API d'Extended n'a pas de CORS : tous les appels passent par le relais `/api/extended/<réseau>/…` (chemins limités à `api/v1/*` et `auth/onboard`, rien n'est stocké). Ordres dimensionnés sur le prix mark d'Extended, arrondis au pas et au tick du marché, minimum vérifié, levier appliqué, fill confirmé (un IOC annulé est un échec, avec la raison). *Preuve : signatures identiques au SDK python officiel (tests `extendedOnboarding`), parcours complet sur le testnet Extended le 2026-10-16 (compte ouvert, onboarding répété → même compte, clé API, ordre limite posé puis annulé), tests `extended-live`.*
- [ ] [toi] Connecter Extended (mainnet), déposer 15-20 $ sur extended.exchange avec le même wallet, ouvrir puis fermer un long ETH minimal (0,01 ETH). *Preuve : fill affiché + position dans Risk → Perp positions.*
- [x] [moi] Dépôt vers Extended depuis Meridian : USDC d'Arbitrum par le pont Rhino.fi d'Extended (devis, engagement, `depositWithId`), suivi jusqu'au crédit. *Preuve : tests `extendedBridge` ; [toi] premier dépôt réel de 10-20 $ à valider.*
- [ ] [moi] Prouver Ondo, Lighter en réel puis GMX v2 (Arbitrum, ordres on-chain via `onchain.ts`).

**P6 Intelligence du planner**
- [x] [moi] Doctrine du stratège (`src/lib/planner/STRATEGIST.md`, à éditer pour changer le raisonnement) : ordre de travail, intentions (ordre explicite, farming de volume, carry neutre, rendement, hedge, vue directionnelle), contraintes dures, quand poser une question (une seule, réponses cliquables), discipline des données, capacités réelles de Meridian, playbooks (dont la paire delta-neutre entre deux venues), classement, exemples réels. *Preuve : tests `planner/*`.*
- [x] [moi] Données pour raisonner : marchés Extended (crypto + actions/indices/matières premières), funding croisé Hyperliquid ↔ Extended avec la paire à prendre, solde du compte Extended. *Preuve : tests `perpVenues`.*
- [x] [moi] Contrat déterministe du planner (`src/lib/planner/`) : `STRATEGIST.md` (règles stables), `capabilities.ts` (ce qui s'exécute, depuis le code), `policy.ts` (taille, levier, buffer, horizon), `schema.ts` (sortie + contrôles serveur : demandé / alternative, bloqué, économie recalculée, recommandation parmi les plans demandés, classement par objectif). *Preuve : tests `planner/schema` sur les cas de référence de la doctrine.*
- [x] [moi] Paires neutres : même quantité de base, seconde jambe dimensionnée sur le fill de la première, état « partiellement exécuté » signalé dans Strategies. *Preuve : tests `strategyTracker`.*
- [x] [moi] Planner v3 (second audit) : pipeline en quatre temps — le LLM propose, le serveur valide (capacités, taille, économie jambe par jambe depuis les cotations : quantité valide sur les deux marchés, prix de référence, notionnel, carry signé par jambe), le serveur classe (clés de `RANKING_POLICY`, aucune opinion), le LLM explique sans rien changer (texte avec un chiffre absent du plan validé → résumé déterministe). Arbre à trois branches ; plans bloqués à chiffres nuls (aucune taille inventée) ; capital compté une fois + capital disponible / à apporter / frais de transfert ; rendement en % (×100), nul avec raison si horizon ou capital ≤ 0 ; politiques explicites de fraîcheur, d'exécution des paires (séquence, IOC, slippage, temps non couvert, fill partiel, signatures) et de stop-loss (mouvement de prix ; « % de la marge » ÷ levier). *Preuve : tests `planner/schema`, `planner/explain`, `explicitOrder`.*
- [ ] [moi] Exécution atomique d'une paire en un clic (aujourd'hui deux signatures successives ; en cas d'échec de la seconde, l'utilisateur ferme la première).
- [ ] [toi] Rejouer « beta neutral pour farmer du volume entre Extended et Hyperliquid » et « short AMD sur Extended ». *Preuve : la paire est le plan demandé (bloqué tant qu'Extended est vide) ou une question ; le short AMD reste sur Extended, Hyperliquid n'apparaît qu'en alternative étiquetée.*
- [ ] [toi] Décider du modèle du planner : `OPENROUTER_MODEL` pour la proposition (par défaut Gemini 2.5 Flash ; un modèle plus fort raisonne mieux sur ces données), `OPENROUTER_EXPLAIN_MODEL` pour l'explication (par défaut le même ; un modèle rapide suffit).

**P5 Suivi des positions perps**
- [x] [moi] Onglet Risk : le panneau « Perp positions » remplace « Vault risk ». Toutes les positions (Hyperliquid, HIP-3, Extended) avec PnL latent et ROE, funding reçu / payé depuis l'ouverture, distance à la liquidation (orange < 25 %, rouge < 10 %), SL / TP ; totaux en tête (PnL, funding, marge, position la plus proche de la liquidation) ; rafraîchi toutes les 15 s. *Preuve : tests `perpPositions` ; signe du funding Hyperliquid vérifié sur positions réelles (`cumFunding.sinceOpen` positif = payé) ; captures desktop et mobile.*

### Phase 1 — Bêta fermée : apprendre et fiabiliser (semaines 3-8)

**Objectif : 50 testeurs, plus de 90 % des transactions signées confirmées.**

**1.1 Boucle de retours**
- [ ] [moi] Routine hebdomadaire : lire `/admin` + rapports, classer les 5 problèmes qui font perdre le plus d'utilisateurs, les corriger dans la semaine. Compte rendu daté dans le journal (§7).

**1.2 Évaluer le planner**
- [ ] [moi] `eval/prompts.json` : 50 prompts réels (issus de `[plan-log]`) ; `eval/wallets.json` : 5 portefeuilles types (petit stable, ETH holder, multi-chaînes, Hyperliquid, vide).
- [ ] [moi] `scripts/eval-planner.ts` : appelle la même chaîne que `/api/parse-intent` (prompt + validateur) et note chaque stratégie : chaque étape a un bouton exécutable (`resolveOrderForLeg` / bouton dédié) · capital frais ≤ solde libre (`freshCapitalUsd`) · APY cité présent dans les données live · 3 mécanismes distincts · aucune venue désactivée. Sortie : rapport markdown + score global.
- [ ] [moi] Workflow GitHub manuel (`workflow_dispatch`) qui lance l'évaluation avec le secret OpenRouter. *Preuve : run vert + rapport en artefact.*
- [ ] [moi] Comparer Gemini Flash, Claude Sonnet et un modèle rapide via `OPENROUTER_MODEL` : score, latence, coût par plan ; tableau dans ce fichier ; [toi] choisir (D4).

**1.3 Exécution multi-étapes fiable**
- [ ] [moi] « Exécuter tout » couvre les étapes dédiées (bridge → attente d'arrivée → dépôt, Pendle, Morpho), pas seulement les ordres directs (`useStrategyExecutor`).
- [ ] [moi] Reprise après erreur : progression persistée par plan (localStorage), bouton « reprendre à l'étape N ».
- [ ] [moi] Test fork de bout en bout d'une stratégie à 3 étapes (bridge simulé + supply + swap). *Preuve : CI.*

**1.4 Positions complètes**
- [ ] [moi] Lire les parts des vaults ERC-4626 suivis (`lib/protocols/vaults.ts` : Fluid, Spark Savings, Sky, Ethena, Yearn) via `balanceOf` + `convertToAssets`.
- [ ] [moi] Lire les parts Morpho (coffres MetaMorpho), les PT Pendle détenus (+ échéance), les parts EigenLayer (`StrategyManager`), les demandes de retrait Lido.
- [ ] [moi] Afficher ces positions dans le portefeuille et les compter dans la valeur nette (jamais dans le solde libre). *Preuve : tests de parsing + capture avec un wallet réel.*

**1.5 Suivre les stratégies**
- [ ] [moi] Page « Mes stratégies » (`lib/strategyTracker.ts`) : valeur d'entrée, valeur actuelle (depuis les positions), rendement réalisé, étapes confirmées avec hashes.
- [ ] [moi] Bouton « Sortir » : génère le plan inverse (withdraw, unstake, vente PT ou attente d'échéance) et l'exécute par le chemin validé.

**1.6 Réactiver ce qui a été masqué**
- [ ] [moi]+[toi] Une venue à la fois (Hyperliquid perps d'abord, puis Extended, Ondo, Lighter) : parcours prouvé en réel → flag activé → ligne dans le tableau des parcours prouvés.

**Critère de sortie :** 50 testeurs · > 90 % des tx signées confirmées · 30 % des testeurs reviennent chaque semaine · score d'évaluation du planner > 85 %.

### Phase 2 — Produit solide, bêta ouverte (mois 3-4)

**Objectif : ouvrir sans mot de passe et prouver un revenu.**

**2.1 Comptes et persistance**
- [ ] [toi] Choisir la base (D5 : Neon Postgres via Vercel Marketplace recommandé).
- [ ] [moi] Connexion par signature de wallet (SIWE, EIP-4361) : `/api/auth/nonce`, `/api/auth/verify`, cookie de session signé.
- [ ] [moi] Historique, stratégies suivies et préférences en base (migration depuis localStorage au premier login).

**2.2 Profil de risque**
- [ ] [moi] 3 questions (horizon, perte acceptable, besoin de liquidité) → profil stocké ; envoyé au planner ; le validateur écarte les stratégies hors profil (levier, lock-up, perps).

**2.3 Alertes**
- [ ] [moi] Vercel Cron toutes les 15 min : health factor sous un seuil, APY d'une position qui chute de plus de 30 %, PT à 7 jours de l'échéance, funding qui s'inverse sur un short.
- [ ] [moi] Notifications email (Resend) et Telegram (bot), avec le lien vers le plan de réaction pré-rempli.

**2.4 Sécurité**
- [ ] [moi] Dossier d'audit : chemin d'exécution, allowlists, simulation, signature Hyperliquid, menaces connues.
- [ ] [toi] Audit externe du chemin d'exécution ; bug bounty.
- [ ] [moi] Page publique « Comment Meridian protège vos fonds ».

**2.5 Monétisation**
- [ ] [moi] Frais d'intégrateur LI.FI (`integrator` + `fee` dans les devis) et deBridge (affiliate fee), affichés avant signature.
- [ ] [moi] Builder code Hyperliquid (champ `builder` des ordres + `approveBuilderFee` signé par l'utilisateur).
- [ ] [moi] Revenu par jour et par utilisateur dans `/admin`.
- [ ] [toi] Fixer les taux de frais (D3).

**2.6 Juridique et ouverture**
- [ ] [toi] Avis d'avocat (outil non custodial, pas de conseil en investissement, MiCA), CGU, pays exclus.
- [ ] [moi] CGU et mentions de risque dans l'app, géoblocage des pays exclus.
- [ ] [moi] Remplacer le mot de passe par des codes d'invitation, puis liste d'attente, puis accès libre.
- [ ] [moi] Parcours complet testé en viewport mobile (Playwright) + [toi] test réel sur téléphone via WalletConnect.

**Critère de sortie :** 500 utilisateurs actifs par mois · revenu récurrent mesurable · audit sans faille critique ouverte.

### Phase 3 — Le terminal agentique (mois 4-7)

**Objectif : Meridian surveille et agit dans des mandats fixés par l'utilisateur.**

**3.1 Agent à outils**
- [ ] [moi] Remplacer le prompt unique par une boucle d'appels d'outils : `getPortfolio`, `getYields(asset, chain)`, `quoteBridge`, `getFunding`, `simulatePlan`, `validatePlan` ; chaque chiffre cité vient d'un outil.
- [ ] [moi] Le validateur déterministe reste la porte finale ; l'évaluation de la Phase 1 doit garder un score ≥ celui du prompt unique.
- [ ] [moi] Afficher le raisonnement de l'agent pas à pas (outils appelés, résultats).

**3.2 Mandats**
- [ ] [moi] Modèle de mandat en base : condition (health factor, écart de taux + rentabilité du bridge, funding), action autorisée, plafonds (montant, fréquence), protocoles autorisés, expiration.
- [ ] [moi] Interface de création, liste, pause, révocation en un clic.

**3.3 Exécution déléguée bornée**
- [ ] [toi] Décider du modèle (D7) : smart account ERC-4337 / ERC-7702 avec session keys.
- [ ] [moi] Session key limitée aux cibles d'`onchain.ts`, aux montants et à la durée du mandat, révocable on-chain. *Preuve : test fork qu'une action hors mandat est refusée on-chain.*

**3.4 Surveillance et décisions**
- [ ] [moi] Service de surveillance (cron ou worker) qui évalue les mandats et déclenche l'agent.
- [ ] [moi] Journal de chaque décision (données lues, raison, action, hash) visible par l'utilisateur.

**3.5 Propose avant d'agir**
- [ ] [moi] Mode « propose » : notification + validation en un clic ; mesurer le taux d'acceptation.
- [ ] [moi] Mode « agit » ouvert par mandat seulement quand l'acceptation dépasse 80 %.

**3.6 Stratégies avancées**
- [ ] [moi] Rotation de rendement, delta neutre géré (rebalancement), boucles de levier avec garde-fous, roulement des PT Pendle à l'échéance — chacune avec preuve fork.

**Critère de sortie :** 20 % des utilisateurs actifs ont un mandat actif · zéro action hors mandat.

### Phase 4 — Toute la finance : DeFi + TradFi (mois 6-12)

**Objectif : l'agent raisonne et agit sur tout le patrimoine.**

**4.1 TradFi tokenisée (moteur on-chain existant)**
- [ ] [moi] Bons du Trésor tokenisés non permissionnés (USDY, USTB…), or (PAXG, XAUT) : adresses vérifiées on-chain dans `onchain.ts`, prix, rendements, achat via Uniswap/LI.FI ; ceux qui exigent un KYC (BUIDL, OUSG) marqués « éligibles seulement ».
- [ ] [moi] Actions tokenisées (Ondo Global Markets, xStocks, Backed) là où elles sont accessibles, avec les restrictions par pays.
- [ ] [moi] Perps actions et indices (Hyperliquid HIP-3, Ondo, Lighter) dans le planner.

**4.2 Lecture du patrimoine traditionnel**
- [ ] [toi] Choisir l'agrégateur (D8 : Powens ou Bridge en Europe, Plaid ailleurs ; Interactive Brokers en direct).
- [ ] [moi] Connexion en lecture seule des comptes courtier et bancaires ; positions dans le portefeuille global.

**4.3 Données de marché TradFi**
- [ ] [moi] Cours actions et ETF, taux (T-bills), calendrier macro et résultats ; injectés dans les outils de l'agent.

**4.4 Exécution TradFi via partenaires**
- [ ] [toi] Partenaire courtier régulé (Alpaca, Interactive Brokers, ou un courtier européen) et cadre juridique.
- [ ] [moi] Ordres actions et ETF via l'API du partenaire, avec le même schéma : plan → confirmation → exécution → suivi.

**4.5 Allocation globale**
- [ ] [moi] L'agent propose une allocation crypto + traditionnelle selon le profil de risque et exécute chaque jambe sur le bon rail.

**Critère de sortie :** un utilisateur voit et pilote crypto, actifs tokenisés et compte courtier depuis Meridian.

### Indicateurs

| Indicateur | Source | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|---|---|
| Utilisateurs actifs | wallets connectés | 10 | 50 | 500/mois | 2 000/mois |
| Tx réelles confirmées | `[exec-log]` | 30 | 500 | 5 000/mois | — |
| Taux de réussite (confirmées / signées) | `[exec-log]` | mesuré | > 90 % | > 95 % | > 97 % |
| Plans exécutables (évaluation) | `eval-planner` | mesuré | > 85 % | > 95 % | > 95 % |
| Rétention hebdomadaire | wallets revenus | — | 30 % | 35 % | 40 % |
| Fonds perdus par un bug | incidents | 0 | 0 | 0 | 0 |
| Revenu | frais intégrateur | — | — | mesurable | couvre l'infra |
| Mandats actifs | base | — | — | — | 20 % des actifs |

---

## 5. Décisions ouvertes (à trancher par toi)

| # | Décision | Recommandation |
|---|---|---|
| D1 | Venues visibles pendant la bêta | Masquer Extended, Ondo, Lighter jusqu'à preuve en réel ; garder Hyperliquid si 0.1 est prouvé |
| D2 | deBridge CrosschainForwarder | **Tranché : non** (LI.FI couvre swap + bridge) |
| D3 | Modèle de revenu | Frais d'intégrateur sur les routes en Phase 2 ; abonnement pour l'agent en Phase 3 |
| D4 | Modèle du planner | Trancher après l'évaluation 1.2 |
| D5 | Base de données | Neon Postgres (Vercel Marketplace) |
| D6 | Plafond par transaction en bêta | 1 000 $ |
| D7 | Exécution déléguée (Phase 3) | Smart account + session keys bornées et révocables ; décision explicite car elle touche l'invariant 5 |
| D8 | Marché TradFi | Europe d'abord (agrégateur Powens/Bridge), partenaire courtier régulé |
| D9 | Recrutement | Un profil smart contracts / sécurité avant la Phase 3 |

---

## 6. Règles de travail (pour moi)

1. **Début de session** : lire ce fichier, prendre la première case non cochée **[moi]** de la phase en cours. Si elle attend une case **[toi]**, le dire en une ligne et passer à la suivante.
2. **Une PR = une case** (ou un petit groupe de cases liées). Pas de PR fourre-tout, pas de fonctionnalité hors de la phase en cours.
3. **Done = prouvé** : chaque case cochée cite sa preuve (test, run CI, hash, capture, log). « Ça build » n'est pas une preuve.
4. **Ce fichier est mis à jour dans la même PR** : case cochée, tableau d'état §2, parcours prouvés.
5. Bug remonté par un testeur ou par toi : il passe avant toute case de la roadmap.
6. Avant chaque push : `tsc`, `eslint`, `vitest`, et `next build` si des routes ou de l'UI changent ; CI verte avant de proposer le merge.

---

## 7. Journal

| Date | Fait | Preuve |
|---|---|---|
| 2026-10-16 | Bug (test réel) : « AI planner unavailable » sans aucun log serveur et « Extended: HTTP 400 » sans message. Chaque échec de `/api/parse-intent` est maintenant journalisé (modèle, forme de la réponse, raison) et sa raison courte est affichée au testeur ; le relais Extended journalise chaque réponse non-2xx (chemin, statut, début du corps ; jamais les en-têtes) | tests `intentEngine.notice` ; logs Vercel au prochain essai |
| 2026-10-16 | Extended : dépôt depuis Meridian. USDC natif d'Arbitrum → compte Extended par le pont d'Extended (Rhino.fi) : devis, engagement du devis, approbation puis `depositWithId` dans le chemin d'exécution validé (adresse du pont, jeton et identifiant vérifiés avant signature), suivi jusqu'au crédit sur Extended. Étape « Deposit » ajoutée devant un ordre Extended quand le compte manque de marge et que le wallet a l'USDC sur Arbitrum ; dépôt direct dans Tools → Extended. Relais Extended exécuté à Tokyo (serveurs d'Extended ; Paris est géobloqué, HTTP 451). Frais taker Extended corrigés à 0,025 % (doc API) | tests `extendedBridge`, `explicitOrder`, `planner/schema` |
| 2026-10-16 | Onglet « News » dans la colonne de droite : actualités crypto NewsData.io via `/api/news` (clé `NEWSDATA_API_KEY` côté serveur uniquement, cache 15 min ≈ 96 appels/jour sous le quota gratuit de 200, dernier lot servi « delayed » en cas de panne), doublons écartés, liens http(s) seulement, bouton « Ask about this » qui demande l'impact sur les positions à partir des données live | tests `news` ; captures desktop et mobile (données simulées) |
| 2026-10-16 | Bug (test réel) : « AI planner unavailable » — la proposition expirait à 34 s (modèle plus lent). Budgets relevés : route 150 s (Fluid compute autorise 300 s), proposition 100 s, explication 25 s, client 145 s. Extended répondait HTTP 451 (restriction légale sur la localisation du serveur, cdg1) : message clair au lieu de « HTTP 451 » ; texte Extended obsolète du plan local corrigé ; consigne du prompt alignée sur la doctrine (un plan Extended demandé reste sur Extended, bloqué) | logs Vercel prod ; tests |
| 2026-10-16 | Product tour v2 (rejoué une fois par les testeurs) : étape « Try a use case » avec 7 prompts cliquables qui partent directement dans le chat (rendement stable, staking, taux fixe, perp, actions sur Extended, neutre entre venues, hedge ; les perps seulement si activés), étape Extended qui ouvre l'onglet Tools, textes mis à jour (plans bloqués, alternatives, positions perps sur les deux venues) | tests `ProductTour` ; captures desktop et mobile |
| 2026-10-16 | Planner v3 (second audit) : le serveur calcule et classe, le LLM propose puis explique. Économie par jambe depuis les cotations Hyperliquid (perps, HIP-3, spot) et Extended ; quantité commune aux deux marchés ; capital compté une fois ; rendement ×100 ; plans bloqués sans chiffres inventés ; politiques de fraîcheur, d'exécution et de stop-loss ; arbre à trois branches | tests `planner/schema` (cas de référence à soldes univoques : 0 status ok vs inconnu), `planner/explain`, `explicitOrder` |
| 2026-10-16 | Planner v2 (audit du propriétaire) : contrat déterministe. Doctrine stable sans faits changeants ; registre des capacités et politique de dimensionnement générés depuis le code ; arbre de décision unique (construire / bloqué / demander) ; plan demandé séparé des alternatives (changements nommés, jamais recommandées) ; statut bloqué avec raisons (Extended jugé côté serveur, solde inconnu ≠ 0) ; chiffres avec provenance (observé / calculé / hypothèse) ; économie normalisée recalculée par le serveur ; 1 à 3 plans ; paires à quantité de base égale, seconde jambe dimensionnée sur le fill de la première, état « partiellement exécuté » ; statut des sources de données | tests `planner/schema` (cas de référence), `strategyTracker`, `perpVenues` |
| 2026-10-16 | Planner : doctrine `src/lib/planner/STRATEGIST.md` en tête du prompt (lire les données d'abord, décoder l'intention, contraintes dures — plateformes et actifs nommés —, demander une précision quand elle change le plan, classer avec les chiffres, sens du funding). Question de clarification avec réponses cliquables. Données Extended (marchés crypto et RWA, funding), funding croisé Hyperliquid ↔ Extended, solde Extended dans le contexte ; ordre explicite « sur Extended » respecté, marchés Extended résolus (AMD → `AMD_24_5-USD`) | tests `perpVenues`, `planner/*`, `explicitOrder`, `fundingPlanner` ; parcours question → réponse vérifié en local |
| 2026-10-16 | Bug (test réel) : « beta neutral with Extended and HL » donnait des stratégies à 1 $ (POL du wallet), un achat spot sur Uniswap sans fonds et un short sous le minimum Hyperliquid. La marge Hyperliquid compte comme capital ; la jambe longue s'achète sur le spot Hyperliquid (UETH) avec l'USDC du compte, sans sortir les fonds ; les stratégies sous les minimums (10 $ Hyperliquid, 5 $ ailleurs) sont écartées ; Extended n'est proposé qu'avec des fonds sur le compte Extended | tests `strategyIntegrity` (cas réel 1 $ + 66 $), `budgetFit`, `planSpotBuy` |
| 2026-10-16 | Extended connecté par le wallet (trois signatures, plus de clés à coller) via un relais serveur (l'API Extended n'a pas de CORS : l'intégration précédente ne pouvait pas marcher depuis le navigateur) ; ordres au prix mark Extended avec pas, tick, minimum, levier et fill confirmé. Panneau « Perp positions » dans Risk à la place de « Vault risk » : PnL, funding, liquidation, SL/TP sur toutes les venues | tests `extendedOnboarding` (vecteurs SDK python), `extended-live`, `perpPositions` ; testnet Extended |
| 2026-10-16 | Bug (test réel du propriétaire) : short ETH bloqué « needs ~$68.34 » avec 66 $ de marge déposée — l'ordre s'ajuste à la marge quand seul le tampon de frais manque, les plans déposent ce tampon ; l'étape dépôt ne se re-bloque plus une fois les fonds arrivés | tests `fitNotionalToMargin`, `strategyIntegrity` |
| 2026-10-16 | Restaking liquide exécutable : Kelp rsETH / wrsETH, Renzo ezETH, ether.fi weETH par swap Uniswap sur Base et Arbitrum | `e2e/restaking.fork.test.ts` (Arbitrum), cotations live (Base), tests `protocols` |
| 2026-10-16 | Bug : « short ETH levier 2, SL 20% » donnait du lending. Un ordre explicite (côté, marché, levier, SL/TP, taille) devient la stratégie 1, garanti côté serveur ; SL/TP pré-remplis sur le bouton perp | tests `explicitOrder` |
| 2026-10-16 | Perps HIP-3 (actions, indices, matières premières) : résolution des marchés, identifiants d'actif, levier isolé, abstraction de dex, liste live dans le planner, positions et ordres dans le panneau | tests `hyperliquidExchange` (vecteurs SDK), `hyperliquidTrade` (HIP-3) |
| 2026-10-16 | Ordres limite Hyperliquid (GTC / post-only), annulation et déplacement des ordres ouverts, stop-loss / take-profit visibles dans le panneau | tests `hyperliquidExchange` (vecteurs SDK cancel, batchModify), `hyperliquidTrade` |
| 2026-10-15 | Perps Hyperliquid : marge et funding avant signature, attente du dépôt, transfert spot → perps, stop-loss / take-profit (ordres trigger) après le fill, fermeture depuis l'étape ; retrait Hyperliquid pour comptes unifiés (PR #38) | tests `hyperliquidExchange` (vecteur SDK trigger), `hyperliquidTrade`, `hedgesSpot` |
| 2026-10-15 | Retrait Hyperliquid → Arbitrum (withdraw3 signé par le wallet, vecteurs SDK) inséré automatiquement quand une stratégie hors perps a besoin des USDC du compte Hyperliquid ; bridge et dépôt suivants attendent l'arrivée | tests `hyperliquidExchange`, `budgetFit`, `fundingPlanner` |
| 2026-10-15 | Solde libre réel, budget appliqué, taux live derrière le mot de passe, prix de tous les jetons, wrap ETH auto, bug report, WalletConnect | PR #35 |
| 2026-10-14 | Signature Hyperliquid officielle (clé de trading), vente spot UETH/UBTC | PR #34 |
| 2026-10-13 | Un seul chemin d'exécution, code mort supprimé, parcours d'or et bridge prouvés sur forks, Pendle et EigenLayer exécutables | PR #16-#33 |

---

