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
| Portefeuille (8 chaînes EVM + compte Hyperliquid) | ✅ soldes, Aave, donut d'allocation, prix de tous les jetons suivis ; positions DeFi (vaults, MetaMorpho, Pendle PT/YT/LP, EigenLayer, retraits Lido) depuis 2026-10-21 | Positions DeFi pas encore vues avec un wallet réel |
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
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Bot neutre sur le serveur : son état (Upstash Redis, Marketplace Vercel) | **à ajouter** (gratuit) |
| `QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | Bot neutre sur le serveur : le déclencheur chaque minute (Upstash QStash, Marketplace Vercel) | **à ajouter** (gratuit) |
| `BOT_ENCRYPTION_KEY` | Chiffre les clés de trading confiées au serveur (32+ caractères aléatoires, `openssl rand -base64 48`) | **à créer** (sensible, production) |

### 3.5 Hyperliquid

- **HyperEVM (chaîne 999)** : 8e chaîne active. Jetons suivis (USDT0, USDe, WHYPE, UETH, UBTC — symbole et décimales vérifiés on-chain), solde natif HYPE, RPC officiel, bridges entrants/sortants via LI.FI (diamond propre à HyperEVM, `0x0a07…ce1A`, confirmé par l'API LI.FI et on-chain) et deBridge (DlnSource, id interne 100000022). Un stable USD bridgé vers HyperEVM arrive en USDT0.
- **Dépôt Hyperliquid exécutable** : USDC natif d'Arbitrum → Bridge2 officiel (`0x2Df1…3dF7`, ~400 M$ USDC), crédité sur le compte Hyperliquid en ~1 min. Garde-fous dans le builder : USDC Arbitrum uniquement, minimum 5 USDC (en dessous, perdu). Prouvé sur fork Arbitrum en CI.
- **Portefeuille** : le compte Hyperliquid réel (mainnet, lecture seule) — marge perps, soldes spot, part HLP — s'ajoute aux avoirs. Avant : lu sur le testnet, donc jamais vu.
- **Trading** : perps (IOC au marché, levier) et vente spot UETH/UBTC signés par une clé de trading approuvée une fois par le wallet (`hyperliquidExchange.ts` vérifié contre le SDK Python officiel, `hyperliquidTrade.ts`) ; UETH sur HyperEVM transféré vers l'adresse système HyperCore avant la vente. **Jamais exécuté en réel (Phase 0.1).**
- **Dépôt HLP et staking HYPE exécutables** (2026-10-21) : HLP par `vaultTransfer` signé par la clé de trading (USDC du compte, déplacé spot → perps si besoin, verrouillé 4 jours) ; staking par `cDeposit` puis `tokenDelegate` signés par le wallet, délégué au validateur actif le plus staké à commission ≤ 5 % (désengagement : 7 jours). Signatures identiques au SDK Python officiel (vecteurs dans `hyperliquidExchange.test.ts`). Retrait d'HLP et undelegate : encore dans l'app Hyperliquid.
- **Données** : HLP (APR live), écosystème HyperEVM via DefiLlama (« Hyperliquid L1 ») : HyperLend, Kinetiq, Felix en comparaison, onglet Yields « HYPE ».

### 3.5 bis TxFlow

- **API** (docs.txflow.com/api, bêta) : lectures `POST /info` non signées, écritures `POST /exchange` signées en EIP-712, sur `rpc.txflow.com` (chaîne TxFlow 869). Deux signatures : directe par le wallet (`approveAgent`, `withdraw3`, domaine déplacé sur la chaîne du wallet par `signatureChainId`) et « Agent » (msgpack de l'action sans `type` ‖ nonce ‖ drapeau vault → `connectionId`) par une clé de trading gardée dans le navigateur. `txflowExchange.ts` reproduit les vecteurs officiels de la doc (encodage, `connectionId`, signature d'ordre, `approveAgent`).
- **Relais** `/api/txflow/<réseau>/{info|exchange}` : même origine pour lectures et écritures, rien n'est stocké.
- **Trading** (`txflowTrade.ts`) : ordre IOC à 1 % au-delà du mark, sur le tick, quantité sur `szDecimals` ; levier posé avant d'ouvrir ; réponse demandée en `confirm: "executed"` ; le fill est lu par la variation de la position (la réponse ne dit pas ce qui a été rempli). Fermeture reduce-only. Pas encore de stop-loss / take-profit depuis Meridian (le planner le dit).
- **Fonds** : dépôt = transfert d'USDC natif Arbitrum vers le Bridge2 de TxFlow (adresse lue en direct via `settings`, minimum 5 USDC) ; retrait `withdraw3` signé par le wallet (minimum 2 USDC, frais 1 USDC, délai de sécurité).
- **Planner** : marchés et funding TxFlow (lecture `perpMeta` + `activeAssetCtx`, funding publié en % par heure), comparaison avec Hyperliquid / Extended et paire à prendre, cotations pour l'économie jambe par jambe, solde du compte lu par adresse (aucune connexion), ordre explicite « short ETH sur TxFlow », paire construite par le serveur « neutre entre TxFlow et Hyperliquid ». **Jamais exécuté en réel.**

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
- [x] [moi] TxFlow (demandé le 2026-10-21, « un perp comme Extended ») : ordres perps, dépôt et retrait depuis les étapes du plan, positions dans Risk → Perp positions, venue de la paire en un clic, planner (marchés, funding croisé, solde, ordre explicite, paire serveur). Voir §3.5 bis. *Preuve : tests `txflowExchange` (vecteurs officiels), `txflow-live`, `perpPair`, `planner/pair`, `explicitOrder`, `perpVenues`, `perpPositions`.*
- [ ] [toi] TxFlow en réel : déposer 10 $ d'USDC Arbitrum depuis un plan, ouvrir puis fermer un long ETH minimal, puis retirer. *Preuve : la clé de trading approuvée, le fill affiché, la position dans Risk puis le retrait dans le ledger TxFlow.*
- [x] [moi] TxFlow : stop-loss / take-profit liés à la position après le fill (`positionTpsl`, triggers au marché reduce-only sur toute la position, prix sur le tick), confirmés par relecture (`positionTpslOrders`) ; sinon le bouton le dit. Forme de la requête déduite de `modifyTpsl` et de la convention Hyperliquid : la doc ne la détaille pas. *Preuve : tests `txflowExchange` ; [toi] un short avec SL sur mainnet.*
- [ ] [moi] TxFlow : code de builder Meridian (`approveBuilderFee`, frais sur le flux routé) si le propriétaire le décide.

**P6 Intelligence du planner**
- [x] [moi] Doctrine du stratège (`src/lib/planner/STRATEGIST.md`, à éditer pour changer le raisonnement) : ordre de travail, intentions (ordre explicite, farming de volume, carry neutre, rendement, hedge, vue directionnelle), contraintes dures, quand poser une question (une seule, réponses cliquables), discipline des données, capacités réelles de Meridian, playbooks (dont la paire delta-neutre entre deux venues), classement, exemples réels. *Preuve : tests `planner/*`.*
- [x] [moi] Données pour raisonner : marchés Extended (crypto + actions/indices/matières premières), funding croisé Hyperliquid ↔ Extended avec la paire à prendre, solde du compte Extended. *Preuve : tests `perpVenues`.*
- [x] [moi] Contrat déterministe du planner (`src/lib/planner/`) : `STRATEGIST.md` (règles stables), `capabilities.ts` (ce qui s'exécute, depuis le code), `policy.ts` (taille, levier, buffer, horizon), `schema.ts` (sortie + contrôles serveur : demandé / alternative, bloqué, économie recalculée, recommandation parmi les plans demandés, classement par objectif). *Preuve : tests `planner/schema` sur les cas de référence de la doctrine.*
- [x] [moi] Paires neutres : même quantité de base, seconde jambe dimensionnée sur le fill de la première, état « partiellement exécuté » signalé dans Strategies. *Preuve : tests `strategyTracker`.*
- [x] [moi] Planner v3 (second audit) : pipeline en quatre temps — le LLM propose, le serveur valide (capacités, taille, économie jambe par jambe depuis les cotations : quantité valide sur les deux marchés, prix de référence, notionnel, carry signé par jambe), le serveur classe (clés de `RANKING_POLICY`, aucune opinion), le LLM explique sans rien changer (texte avec un chiffre absent du plan validé → résumé déterministe). Arbre à trois branches ; plans bloqués à chiffres nuls (aucune taille inventée) ; capital compté une fois + capital disponible / à apporter / frais de transfert ; rendement en % (×100), nul avec raison si horizon ou capital ≤ 0 ; politiques explicites de fraîcheur, d'exécution des paires (séquence, IOC, slippage, temps non couvert, fill partiel, signatures) et de stop-loss (mouvement de prix ; « % de la marge » ÷ levier). *Preuve : tests `planner/schema`, `planner/explain`, `explicitOrder`.*
- [x] [moi] Paire de perps en un clic (Hyperliquid ↔ Extended, `lib/perpPair.ts` + `PerpPairButton`) : jambe 1 dans l'ordre du plan, jambe 2 à la quantité remplie par la 1 ; si la 2 échoue, la 1 est fermée aussitôt (reduce-only) ; fill partiel → la 1 est réduite à l'identique ; ce qui ne se ferme pas est affiché « exposé » avec la quantité. Pas atomique au sens strict (deux venues) : quelques secondes non couvertes, approbation de la clé de trading demandée avant la première jambe. *Preuve : tests `perpPair`. Reste à prouver : une paire réelle.*
- [ ] [toi] Rejouer « beta neutral pour farmer du volume entre Extended et Hyperliquid » et « short AMD sur Extended ». *Preuve : la paire est le plan demandé (bloqué tant qu'Extended est vide) ou une question ; le short AMD reste sur Extended, Hyperliquid n'apparaît qu'en alternative étiquetée.*
- [ ] [toi] Décider du modèle du planner : `OPENROUTER_MODEL` pour la proposition (par défaut Gemini 2.5 Flash ; un modèle plus fort raisonne mieux sur ces données), `OPENROUTER_EXPLAIN_MODEL` pour l'explication (par défaut le même ; un modèle rapide suffit).

**P7 Bot neutre (farming de points, carry de funding) — demandé le 2026-10-22**
- [x] [moi] Scanner d'opportunités (`lib/neutralBot/opportunities.ts`, `/api/perp-markets`) : toutes les paires liquides entre Hyperliquid, Extended et TxFlow, orientées par le funding, avec spread annuel, frais aller-retour, délai de remboursement et arbitrage de funding signalé ; classement « volume le moins cher » (farming) ou « meilleur carry ». *Preuve : tests `opportunities`.*
- [x] [moi] Bot neutre dans Tools (`NeutralBotPanel`, `lib/neutralBot/engine.ts` + `runner.ts`) : tient une paire delta-neutre, mode Farm (rotation planifiée pour le volume et l'OI, réorientée par le funding) ou Carry (ouvre au-dessus d'un spread, ferme en dessous) ; rééquilibre une jambe seule ou plus grosse, ne touche jamais une position qu'il n'a pas ouverte, budgets (cycles, frais, volume), arrêt sur jambe exposée, pause / « Stop & close ». Tourne depuis l'onglet ouvert, par les clés de trading. *Preuve : tests `engine`, `runner`.*
- [x] [moi] Planner : « maximize volume/OI », « boost volume », « farm », « airdrop » = farming de points ; sans actif nommé, le serveur propose les meilleures paires sur les venues connectées ; levier farming 3x par défaut, relevé (≤ 5x) quand la marge reste sous le minimum du marché ; la part du capital se calcule sur les deux venues ensemble ; dépôt automatique vers une venue vide ; bouton « Automate it » sur le plan. *Preuve : tests `schema`, `sizing`, `pair`.*
- [x] [moi] Bot v2, fonctionnalité phare (demandé le 2026-10-22) : sa propre vue dans la colonne centrale (Terminal | Neutral bot), carte d'accueil, puce d'état dans la barre du haut, et un moteur qui tourne au niveau de la page (`NeutralBotHost`, `lib/neutralBot/store.ts`) : changer d'onglet ne l'arrête plus. Suivi en direct : une ligne d'état (« All good: hedged… next close at… », marge manquante avec bouton de dépôt, pause, arrêt), volume total et sur 24 h, frais, funding estimé, coût net par 10 k$, open interest, PnL de la couverture, cycles, prochaine vérification, courbe du volume, les deux jambes (entrée, mark, PnL, funding), journal coloré. Horaires et tailles aléatoires en Farm : durée de détention et pause tirées dans des plages, taille ± %. La marge manquante n'est plus une erreur : le bot attend le dépôt. *Preuve : tests `engine`, `runner`, `health`.*
- [x] [moi] Bot v3, mise en route guidée (demandé le 2026-10-22 : « on ne comprend rien et est vite perdu ») : bot éteint = 4 étapes en clair. 1) L'argent sur chaque venue (USDC du wallet sur Arbitrum, marge libre sur Hyperliquid, Extended, TxFlow, avec le bouton à utiliser : connecter, déposer, déplacer l'USDC spot Hyperliquid vers les perps). 2) Le choix d'une paire parmi 3 cartes (frais par 10 k$ de volume, funding payé ou coûté), objectif Farm ou Carry. 3) Taille par côté (avec « Use max » selon les dépôts), levier 1-5x, rythme Calm / Normal / Intense, budget de frais, et l'estimation du volume, des frais et des paires par jour. 4) Ce qui manque encore, puis Start. Réglages fins repliés. Bot allumé = tableau de bord resserré (4 chiffres, courbe, paire, journal). *Preuve : tests `neutralBot/guide`.*
- [x] [moi] Bot v4, garde-fous (demandé le 2026-10-22 : « pas de SL/TP, liquidé des deux côtés ? », « équilibre-t-il la marge ? », « marge ou size ? »). Fermeture de sécurité : le bot ferme les deux jambes quand le prix s'est éloigné de l'entrée d'environ la moitié de la distance de liquidation (±17 % à 3x, réglable). Stop posé sur la venue pour les jambes Hyperliquid et TxFlow (22,5 % à 3x), actif même onglet fermé ; les stops restants sont annulés quand la jambe est fermée. Pas encore de stop côté Extended. Marge : chaque paire fermée fait passer son PnL d'une venue à l'autre ; quand la venue la plus mince ne couvre plus la taille, le bot ouvre ce qu'elle couvre au lieu d'attendre (le transfert entre venues reste manuel). Saisie : deux champs liés, « marge par venue » et « position par côté = marge × levier ». *Preuve : tests `engine` (garde-fou), `runner` (stops, taille réduite).*
- [x] [moi] Bot v5, mode maker (demandé le 2026-10-22) : la jambe Hyperliquid part en ordre post-only au meilleur prix (0,015 % au lieu de 0,045 %), l'autre jambe est couverte au marché au fur et à mesure des exécutions (`lib/neutralBot/maker.ts`) : ré-postée si le carnet bouge, ouverture plus petite si tout n'est pas exécuté à l'échéance (la tranche impossible à couvrir est refermée), fermeture terminée au marché. Environ 40 % de frais en moins sur une paire Hyperliquid + Extended. *Preuve : tests `maker`, `runner` (mode maker).*
- [x] [moi] Arbitrage DEX ↔ perps (demandé le 2026-10-22) : nouvel onglet Arbitrage. Scanner toutes les 30 s des écarts entre le prix d'un token sur DEX (pool le plus profond sur Ethereum, Arbitrum, Base, Optimism, via DexScreener) et son perp sur Hyperliquid, Extended et TxFlow, nets des coûts aller-retour (frais DEX + impact, gas, frais perp) ; journal des détections, badge dans l'onglet, notifications navigateur. Trade en deux étapes : prix exact on-chain (LI.FI / deBridge), swap signé dans le wallet, puis couverture perp envoyée automatiquement ; suivi des trades ouverts (écart, PnL) et fermeture des deux jambes. *Preuve : tests `arb/scan`.*
- [x] [moi] Bot v6, sur le serveur 24/7 (demandé le 2026-10-22 : « il s'arrête quand l'ordinateur est en veille ») : option « On Meridian's server, 24/7 » à l'étape 4. L'état est stocké dans Upstash Redis, un tick par minute déclenché par Upstash QStash (signature vérifiée). Les clés de trading (agents Hyperliquid et TxFlow, clés Extended) sont chiffrées en AES-256-GCM avec `BOT_ENCRYPTION_KEY`. Démarrer, mettre en pause, fermer et oublier sont signés par le wallet. Le serveur passe par un relais Extended à jeton (`/api/extended-srv`), car la protection beta bloquerait l'appel. Mode navigateur : reprise automatique au réveil, coupure réseau non comptée comme échec, écran maintenu allumé. *Preuve : tests `server` (chiffrement, signature QStash, signature wallet), `tickState`.*
- [ ] [toi] Ajouter Upstash Redis + QStash (Marketplace Vercel) et `BOT_ENCRYPTION_KEY`, puis lancer le bot « On Meridian's server » avec un petit montant. *Preuve : le journal du bot avance ordinateur fermé.*
- [ ] [toi] Lancer le bot en Farm sur ETH Hyperliquid ↔ Extended (10-20 $ par jambe, rotation 30 min, budget de frais 1 $) et le laisser faire deux rotations. *Preuve : log du bot, volume affiché, positions fermées après « Stop & close ».*
- [ ] [moi] Mode maker (ordres post-only sur les deux jambes) pour réduire les frais du farming, après la preuve en taker.

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
- [x] [moi] « Exécuter tout » reprend aux étapes non confirmées : un bridge fait à la main, le dépôt qui suit passe en « Exécuter les N étapes restantes ». Les étapes dédiées (bridge, Pendle, Morpho, perps) se font toujours une à une, avec un parcours guidé (étape suivante mise en avant, étapes faites cochées, « Aller à l'étape k »). *Preuve : tests `strategyTracker` (remainingLegIndexes).*
- [x] [moi] Reprise après erreur : la progression est celle du suivi des stratégies (localStorage) ; après un échec, « Resume (N left) » relance depuis la première étape non confirmée. Le retrait Hyperliquid et la vente spot Hyperliquid comptent désormais dans le suivi (le transfert préalable ne valide plus la vente). *Preuve : tests `strategyTracker`.*
- [ ] [moi] Test fork de bout en bout d'une stratégie à 3 étapes (bridge simulé + supply + swap). *Preuve : CI.*

**1.4 Positions complètes**
- [x] [moi] Lire les parts des vaults ERC-4626 suivis (`lib/protocols/vaults.ts` : Fluid, Spark Savings, Sky, Ethena, Yearn, Curve) via `balanceOf` + `convertToAssets`. *Preuve : `defiPositions.test.ts` ; le test fork relit chaque dépôt via `convertToAssets` (écart < 1 %).*
- [x] [moi] Lire les parts Morpho (coffres MetaMorpho), les PT Pendle détenus (+ échéance), les parts EigenLayer (`StrategyManager`), les demandes de retrait Lido. *Preuve : `defiPositions.test.ts`, `pendlePositions.test.ts` (forme de l'API Pendle d'après sa spec OpenAPI) ; fork : `sharesToUnderlyingView` rend ~0,5 stETH pour 0,5 restaké.*
- [ ] [moi] Afficher ces positions dans le portefeuille et les compter dans la valeur nette (jamais dans le solde libre). *Preuve : tests de parsing + capture avec un wallet réel.* — Fait (groupe « DeFi positions », test « net worth, never free balance ») ; reste la capture avec un wallet réel.

**1.5 Suivre les stratégies**
- [x] [moi] Page « Mes stratégies » (`lib/strategyTracker.ts`) : valeur d'entrée, valeur actuelle (depuis les positions), rendement réalisé, étapes confirmées avec hashes. *Preuve : `strategyExit.test.ts` (`currentValueUsd` : vaults, EigenLayer ; inconnue pour un compte Aave ou un perp, qui mélangent d'autres fonds).*
- [x] [moi] Bouton « Sortir » : génère le plan inverse (withdraw, unstake, vente PT ou attente d'échéance) et l'exécute par le chemin validé. *Preuve : `strategyExit.test.ts` (carry Aave défait dans l'ordre : retrait LST → swap retour → repay → retrait ; chaque étape résout un ordre signable ; perps, PT Pendle, EigenLayer, cooldown sUSDe → notes ; sortie suivie sur la stratégie d'origine, « Closed » à la fin).*

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
| 2026-10-17 | Extended fonctionne en connectant le wallet (confirmé par le propriétaire). Product tour v3 : l'étape Extended dit les prérequis (compte ouvert sur extended.exchange avec le même wallet, solde en USDC ou dépôt depuis Arbitrum), et le tour se termine par « Try a strategy now » avec les stratégies cliquables qui partent directement dans le chat ; rejoué une fois par les testeurs | tests `ProductTour` |
| 2026-10-17 | Product tour : se lance automatiquement à la première visite pour tout nouvel utilisateur, wallet connecté ou non (accueil adapté sans wallet) ; la carte est placée selon sa vraie hauteur et ne dépasse jamais l'écran (la liste de stratégies défile, les boutons restent visibles, vérifié en 1280×640 et sur mobile 390×700) ; animations : spotlight qui pulse, carte qui arrive avec un reflet, barre de progression animée, contenu en cascade, titre final scintillant ; et dans l'app : entrée des bulles, cartes et panneaux, survol avec élévation, retour au clic sur les boutons (tout désactivé avec prefers-reduced-motion) | tests `ProductTour` |
| 2026-10-17 | Bug Extended trouvé (logs du relais) : tous les champs de l'ordre SPCX étaient corrects ; le numéro de position (vault) enregistré dans le navigateur était `0x2c8f…` au lieu d'un entier, donc Extended ne pouvait pas lire le settlement et refusait chaque ordre par un 400 vide. Avant chaque ordre, un vault non numérique est remplacé par celui qu'Extended renvoie pour la clé d'API (`GET /user/account/info` → `l2Vault`, avec vérification que la clé Stark est bien celle du compte) puis réenregistré ; la connexion manuelle refuse un vault non numérique ; l'ouverture de compte par wallet relit le vault si besoin | tests `extended-live` ; logs du relais (champs de l'ordre) |
| 2026-10-17 | Extended : enquête sur le 400 vide restant (SPCX, après le routage RFQ). Reproduit hors relais depuis Tokyo et Paris avec le même SDK : sur le testnet un ordre marché RFQ via `/user/order/rfq` est accepté (200), via `/user/order` refusé (403 « Action is not allowed ») ; sur le mainnet l'ordre est lu et refusé en JSON (1140, compte vide) — SDK, signature, région et routage sont corrects. Extended ne répond un 400 vide que si un champ obligatoire manque ou est illisible ; le relais reçoit pourtant un JSON valide et le transmet intact (test local). Le relais journalise désormais les champs d'un ordre refusé (jamais la signature) pour trouver le champ en cause au prochain essai | tests `extendedBridge` ; sondes testnet/mainnet en sandbox Vercel (hnd1, cdg1) |
| 2026-10-17 | Questions de marché répondues en mots : « What do you think about the crypto market? » (ou « overview only, no plan ») ne force plus un plan et ne tombe plus sur les règles locales (« No strategies in response »). Le serveur reconnaît la question, lit les prix live (CoinGecko : majors, plus forts mouvements, breadth), les actus (NewsData), le funding, les rendements et le portefeuille, et renvoie `decision: "answer"` : un titre, 3-5 points chiffrés, une conclusion et des requêtes cliquables pour agir. Le modèle peut aussi choisir `answer` de lui-même (« explain funding rates ») ; la doctrine interdit de demander « plan ou overview ? ». Si la lecture échoue : message clair, jamais un plan inventé | tests `planner/answer`, `parse-intent/route`, `intentEngine.answer` |
| 2026-10-16 | Bug (test réel) : « Extended: HTTP 400 » sur chaque ordre SPCX. Cause : SPCX-USD est un marché RFQ chez Extended (`isRfq: true`, 283 des 333 marchés actifs le sont) ; ces ordres doivent partir sur `POST /api/v1/user/order/rfq` (même corps, même signature), le SDK postait toujours sur `/user/order`. Le relais choisit maintenant l'endpoint d'après le marché (liste RFQ lue chez Extended, cache 5 min). Toute l'interface et le planner en anglais uniquement (questions du serveur, consigne du modèle, messages d'erreur du SDK Extended traduits) | tests `extendedBridge` (routage RFQ), `extended-live`, `planner/*`, `parse-intent/route` ; marché vérifié sur l'API publique d'Extended depuis Tokyo |
| 2026-10-16 | Bug (test SPCX après #51) : le planner n'avait aucune mémoire — « Why not open a long on Hyperliquid and a short on Extended? » arrivait seul, et « long on Hyperliquid » était lu comme un ordre sur un actif « HYPERLIQUID ». Désormais : les 4 derniers échanges sont envoyés au planner et une relance sans actif s'applique à la dernière demande qui en nommait un ; un nom de protocole n'est jamais un actif, un ordre n'est retenu que sur un marché listé, « long … et short … » est une position à deux jambes. La position neutre long/short entre Hyperliquid et Extended sur un actif listé des deux côtés est construite par le serveur (long sur le funding le plus bas, short sur le plus haut, même quantité, levier plafonné au maximum des deux marchés, taille = part du capital choisie), sans proposition du modèle ; sans actif, le serveur demande lequel (classés par écart de funding) | tests `planner/pair`, `parse-intent/route` (conversation SPCX rejouée de bout en bout) |
| 2026-10-16 | Bug (logs prod) : Haiku 5.5 ne répondait jamais — son raisonnement interne consommait les 2 048 tokens (`finish: length`, `reasoning_tokens: 2048`). Raisonnement limité (`effort: low`, exclu de la réponse), budget 8 192 tokens. Bug (test SPCX) : une paire `xyz:SPCX` (Hyperliquid) / `SPCX-USD` (Extended) n'était pas reconnue comme le même actif → un faux achat spot sur Uniswap et un bridge depuis Base étaient ajoutés (4 étapes au lieu de 2) ; même défaut sur ETH / ETH-USD. Le serveur dimensionne désormais les jambes perps sur la marge libre de chaque venue × la part choisie × le levier (paire : la plus faible des deux), demande « quelle part de ton capital ? » (100/50/25 %) quand aucune taille n'est donnée, et dit la marge qu'il faut pour atteindre le minimum d'un marché. La marge Extended n'est plus réduite au solde du wallet ; plus d'APY affiché sur un plan perp | tests `planner/sizing`, `planner/schema`, `strategyIntegrity` ; logs Vercel |
| 2026-10-16 | Bug (logs prod) : « Empty response from model » — OpenRouter répondait sans contenu pour `anthropic/claude-haiku-5.5`. La réponse est lue aussi sous forme de parties de texte, une erreur renvoyée en HTTP 200 est remontée avec son message, et le modèle par défaut (Gemini 2.5 Flash) prend le relais une fois quand le modèle configuré échoue. Le plan de secours local se dimensionne sur le portefeuille réel (marge libre de chaque venue, la plus faible pour une paire, 1x) au lieu de 20 000 $ à 3x | tests `completion`, `intentEngine.fallback` ; logs Vercel |
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
| 2026-10-19 | Graphiques dans les réponses marché, façon DefiLlama : TVL DeFi totale et offre de stablecoins (90 j), TVL par chaîne, volume DEX (30 j) depuis DefiLlama, et variations 24h (CoinGecko). Le modèle lit les mêmes chiffres et choisit jusqu'à 3 graphiques (par défaut : variations 24h + TVL) ; détection étendue aux questions macro (TVL, stablecoins, volumes, liquidité). Rendu SVG : courbes avec infobulle au survol, barres, barres divergentes vert/rouge avec signe, vue « Data ». Couleurs validées (validate_palette.js). Format DefiLlama non vérifié depuis le conteneur (hôte bloqué) : une source qui change de forme est omise, jamais fausse | tests `planner/marketCharts`, `parse-intent/route` |
| 2026-10-19 | Nouveaux protocoles exécutables (vaults ERC-4626 vérifiés on-chain : asset(), dépôt ouvert à tous, TVL = ligne DefiLlama) : **Curve Savings** (crvUSD → scrvUSD), **Curve LlamaLend** (prêt de crvUSD, marché sfrxUSD), **Fluid GHO**, et le pool sDAI de Sky marqué exécutable. Chaque vault est rattaché à son pool DefiLlama exact (`llamaPool`) : quand un protocole a plusieurs pools pour le même actif, seul le bon taux est montré comme exécutable. crvUSD suivi en wallet et pricé. Écartés : stUSDS (retraits non garantis, pertes socialisables), sfrxUSD (dépôts désactivés), Euler/Gearbox/Silo (< 10 M$ sur nos chaînes) | tests `protocols`, fork `e2e/vaults.fork.test.ts` (CI) |
| 2026-10-21 | Portefeuille complet : nouveau groupe « DeFi positions » compté dans la valeur nette, jamais dans le solde libre — parts des vaults vérifiés (convertToAssets), vaults MetaMorpho (indexeur Morpho), Pendle PT/YT/LP (API dashboard Pendle + nom et échéance lus sur le contrat du marché, « matured, redeemable » à l'échéance), stETH restaké sur EigenLayer (sharesToUnderlyingView), stETH en file de retrait Lido (pending / ready to claim). sUSDe reste un jeton du wallet (pas de double compte) ; les positions Haiku de ces protocoles ne s'ajoutent plus | tests `defiPositions`, `pendlePositions`, fork vaults + EigenLayer |
| 2026-10-21 | Mes stratégies + Sortir : chaque carte montre la valeur actuelle lue sur la position (vaults, EigenLayer) et le résultat vs la mise ; bouton « Exit » qui envoie dans le chat le plan inverse (dernière étape d'abord : retrait vault/lending, repay avant retrait du collatéral, swap retour, unstake Lido, vente UETH et retrait Hyperliquid), exécuté par les boutons habituels. Ce qui ne se défait pas depuis Meridian (perps, PT avant échéance, file EigenLayer, cooldown sUSDe) devient une note qui dit où agir. Les étapes de sortie sont enregistrées sur la stratégie d'origine (« Exiting 1/3 », puis « Closed ») | tests `strategyExit` |
| 2026-10-21 | Hyperliquid : dépôt HLP et staking HYPE exécutables depuis Meridian (boutons dédiés dans le plan et dans la carte de rendements HLP ; le planner les propose). Signatures vérifiées contre le SDK Python officiel (vaultTransfer, cDeposit, tokenDelegate). « Sortir » et « Value now » couvrent HLP et HYPE staké (sortie : notes vers l'app, verrouillage 4 j / file 7 j) | tests `hyperliquidExchange` (vecteurs SDK, choix du validateur), `strategyExit` |
| 2026-10-21 | Exécution plus fluide : « Exécuter tout » reprend aux étapes restantes (après un bridge fait à la main ou une erreur), parcours guidé dans chaque plan (étape suivante en évidence, étapes faites cochées), paire de perps Hyperliquid ↔ Extended en un clic avec fermeture automatique de la première jambe si la seconde échoue (ou réduction si fill partiel). Retrait et vente spot Hyperliquid enregistrés dans le suivi | tests `perpPair`, `strategyTracker` |

| 2026-10-21 | TxFlow, nouvelle venue perps comme Extended : signature EIP-712 (vecteurs officiels reproduits), relais `/api/txflow`, clé de trading approuvée une fois par le wallet, ordres IOC avec lecture du fill sur le compte, dépôt vers le Bridge2 (adresse lue en direct) et retrait `withdraw3`, positions dans Risk, troisième venue de la paire en un clic, et côté planner : marchés et funding TxFlow, comparaison avec Hyperliquid / Extended, économie et dimensionnement, solde lu par adresse, « short ETH sur TxFlow », paire serveur avec TxFlow. Pas encore testé en réel | tests `txflowExchange`, `txflow-live`, `perpPair`, `planner/pair`, `explicitOrder`, `perpVenues`, `perpPositions` |

| 2026-10-21 | TxFlow dans Tools (retour du propriétaire : « je ne vois pas TxFlow comme Extended dans Tools ») : panneau avec connexion (clé de trading approuvée par une signature), solde, positions avec fermeture, dépôt depuis Arbitrum et retrait. Corrigé : le contrôle de budget prenait la marge des jambes TxFlow sur le compte Hyperliquid ; un dépôt TxFlow est forcé sur Arbitrum ; le parseur local reconnaît « TxFlow ». Le refus « TxFlow is not a venue Meridian can execute » venait de la prod d'avant le merge de #61 | tests `budgetFit` |

| 2026-10-21 | Retour du propriétaire « put 10$ into Hyperliquid main vault » : la question de capital ne se pose plus pour un dépôt (un montant « 10$ » est lu, nommer Hyperliquid ne fait plus d'une requête un trade) ; le dépôt HLP était supprimé comme simple appoint de marge quand le compte avait déjà de la marge, puis précédé d'un retrait inutile vers Arbitrum : il est gardé et payé depuis le compte Hyperliquid ; une jambe « HLP » / « Hyperliquid vault » prend une seule forme (celle du bouton HLP) et n'est plus classée « alternative » ; l'APR HLP de Hyperliquid est une fraction, il s'affichait 100 fois trop petit. TxFlow : stop-loss / take-profit posés après le fill et confirmés par relecture | tests `planner/sizing`, `budgetFit`, `txflowExchange`, `explicitOrder` |

| 2026-10-21 | Retours du propriétaire : TxFlow refusait la clé de trading (« You must approve at least one builder ») : la connexion approuve d'abord le builder Meridian `0xD69F…c4E2` (choix du propriétaire : 0 % de frais, plafond minimal 0,001 %, aucun frais attaché aux ordres), seulement si aucun builder n'est déjà approuvé (`approvedBuilders`). La fenêtre de confirmation s'ouvrait dans la carte, en haut du fil : elle est rendue sur `document.body` (portail), au centre de l'écran. Tools commence par « Perp venues » : Hyperliquid, Extended, TxFlow, Ondo, Lighter, leur état et un lien vers chaque panneau | tests `txflowExchange` |
| 2026-10-21 | Retour du propriétaire : sur mainnet, TxFlow refuse le builder Meridian (« This builder address is restricted by the platform ») : les builder codes y sont en accès limité (candidature sur txflow.com/apply). Le refus donne maintenant un message clair et un lien vers app.txflow.com : y activer le trading une fois approuve le builder de TxFlow, puis Connect saute l'étape builder. À faire côté propriétaire : candidater pour le builder `0xD69F…c4E2` | tests `txflowExchange` |
| 2026-10-22 | Retour du propriétaire : « open a beta neutral position, maximize volume and OI — 25% of my available capital » donnait deux jambes de 4,80 $ bloquées sous les minimums (25 % appliqués à la plus petite venue). La part se calcule maintenant sur les deux venues ensemble (14 $ de marge par jambe ici), le farming prend 3x par défaut et le levier est relevé (≤ 5x) pour passer le minimum ; « volume / OI / boost / farm / airdrop » est compris comme du farming de points, et sans actif nommé le serveur propose les meilleures paires. Nouveau bot neutre dans Tools : scanner de funding et d'arbitrage, suggestions de paires, mode Farm (rotations) ou Carry, budgets et garde-fous | tests `neutralBot/*`, `schema`, `sizing`, `pair` |
| 2026-10-22 | Retour du propriétaire sur le bot (« c'est un des features clefs, à mettre en avant, monitorer, feedback quand tout tourne bien, volume et fees en temps réel, ouvrir les paires à des heures au hasard ») : vue dédiée dans la colonne centrale, puce d'état globale, tableau de bord en direct, horaires et tailles aléatoires. Bug corrigé au passage : la boucle vivait dans le panneau Tools, changer d'onglet arrêtait le bot ; elle tourne maintenant au niveau de la page. « Not enough margin » devient une attente avec le montant à déposer et un lien vers la venue | tests `neutralBot/*` |
| 2026-10-22 | Retours du propriétaire : le devis du pont Extended échouait (« Internal Server Error ») — vu dans les logs Vercel : Extended répond lui-même HTTP 500 (code 1006) sur `/user/bridge/quote`, avec la requête documentée. Le devis réessaie maintenant les autres formes documentées (sans `asset`, montant entier, `asset=USDC`) seulement sur une erreur serveur, puis dit clairement que rien n'a été envoyé et propose app.extended.exchange avec le même wallet. Onglet Chains : la couverture réelle de Meridian (`lib/coverage.ts`, lue dans les tables d'exécution du code : 8 chaînes, 21 protocoles, 3 venues perps), protocole par protocole sur chaque chaîne ; `/api/chains` suit les chaînes actives (BSC et HyperEVM inclus, Solana seulement avec son flag) ; la barre du haut affiche « 8 chains · 21 protocols » | tests `extendedBridge`, `coverage` |

---
| 2026-10-22 | Retours du propriétaire : « Asset not found » sur le dépôt Extended, 0 $ affiché sur Hyperliquid alors que l'argent y est, bot incompréhensible. Extended : le devis renvoie toujours HTTP 500 de leur côté ; la variante `asset=USDC` (qui produisait le trompeur « Asset not found ») est retirée et le message dit la panne d'Extended et le dépôt direct sur app.extended.exchange avec le même wallet. Hyperliquid : le panneau montre aussi l'USDC spot (utilisable comme marge si le compte est unifié), les autres jetons spot, les vaults (HLP…), le HYPE staké et le total ; le bot propose de déplacer l'USDC spot vers les perps sur un compte non unifié. Bot : mise en route guidée en 4 étapes (voir P7) | tests `extendedBridge`, `neutralBot/guide` |
| 2026-10-22 | Extended : le devis du pont renvoie toujours HTTP 500 (code 1006, « UnhandledError » dans la doc d'Extended) sur chaque forme de requête, vu dans les logs de prod et de la preview. Le relais tourne à Paris (cdg1) et non à Tokyo comme prévu (`preferredRegion` ignoré sur le plan Hobby). Piste : Extended fait le devis vers l'adresse Starknet de bridge du compte (`bridgeStarknetAddress` dans `GET /user/account/info`) ; un compte ouvert par API peut ne pas en avoir. Après un échec, Meridian lit maintenant cette adresse et, si elle manque, dit de faire un premier dépôt sur app.extended.exchange avec le même wallet ; sinon il garde le message de panne | tests `extendedBridge` ; logs Vercel |
| 2026-10-22 | Cause probable de l'échec des dépôts Extended (signalée par le propriétaire) : Extended a migré son règlement de Starknet vers Arc (L1 de Circle) le 22 octobre à 13:00 UTC ; dépôts et retraits en pause jusqu'à 2 h. Depuis, le devis du pont (`chainOut=STRK`) répond HTTP 500 (code 1006, « UnhandledError »), sur la prod comme sur la preview. La doc API d'Extended dit encore STRK, aucune valeur Arc n'est publiée : Meridian ne devine pas une chaîne de destination pour un dépôt et renvoie vers app.extended.exchange en nommant la migration. À refaire dès qu'Extended publie le nouveau flux, et vérifier que la signature des ordres (domaine Starknet) fonctionne toujours après la migration | tests `extendedBridge` ; logs Vercel ; docs.extended.exchange (migration-from-starknet-to-arc) |
| 2026-10-22 | Retours du propriétaire sur le bot : pas de stop (risque de liquidation), marge qui se déséquilibre entre venues, champ de taille ambigu, coût par volume. Ajouts : fermeture de sécurité par le bot (moitié de la distance de liquidation), stops sur Hyperliquid et TxFlow à l'ouverture (nettoyés à la fermeture), taille réduite à ce que couvre la venue la plus mince, champs « marge par venue » / « position par côté » liés, panneau « Liquidation protection ». Coût par volume : il ne dépend que des frais des deux venues (taker) ; le levier suivant est le mode maker (déjà en roadmap) | tests `neutralBot/*` |
| 2026-10-22 | Demande du propriétaire : mode maker et bot d'arbitrage entre prix on-chain et exchanges. Mode maker dans le bot neutre (jambe Hyperliquid post-only, l'autre au marché à chaque exécution). Onglet Arbitrage : scanner des écarts DEX ↔ perps nets des coûts, alertes, trade couvert en deux étapes (swap signé, perp automatique) et suivi des positions. Limites : seule la jambe Hyperliquid peut être maker ; chaque swap on-chain demande une signature du wallet (pas d'exécution on-chain autonome) ; les prix DEX du scanner sont des prix moyens de pool, le prix exact vient du devis du routeur avant de signer | tests `neutralBot/maker`, `neutralBot/runner`, `arb/scan` |
| 2026-10-22 | Retour du propriétaire : le bot s'arrêtait quand l'ordinateur se mettait en veille (il tournait dans l'onglet). Le propriétaire a choisi le serveur Meridian (Upstash Redis + QStash) et de confier les trois clés de trading, chiffrées. Construit : le bot côté serveur (tick chaque minute, verrou par wallet, même moteur que dans le navigateur grâce à `perpCore` et `tickState`), les actions signées par le wallet, un relais Extended à jeton pour le serveur, et le choix navigateur / serveur à l'étape 4. En mode navigateur : reprise au réveil, coupure réseau non comptée comme échec, écran maintenu allumé. Reste à faire côté propriétaire : ajouter Upstash et `BOT_ENCRYPTION_KEY` dans Vercel | tests `server`, `tickState`, `neutralBot/*` |
| 2026-10-23 | Retours du propriétaire : news vieilles de 25 h (l'offre gratuite de NewsData a 12 h de retard), arbitrage trop mis en avant, dépôts Extended rétablis côté Extended après la migration Arc. News : flux RSS temps réel (CoinDesk, Cointelegraph, Decrypt, The Block, Blockworks) fusionnés avec NewsData, une entrée par titre, rafraîchis toutes les 5 min, coins détectés dans les titres. Arbitrage : l'onglet central est supprimé, remplacé par une carte compacte dans Tools (4 meilleurs écarts, trade et alertes repliés). Extended : le flux de dépôt documenté est inchangé (doc API identique) ; le message renvoie vers app.extended.exchange seulement si le dépôt échoue. Upstash Redis et QStash sont configurés dans Vercel ; `BOT_ENCRYPTION_KEY` reste à créer | tests `newsRss` |
