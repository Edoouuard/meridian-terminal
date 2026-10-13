# Meridian — Master document

> Vision, architecture, état réel et roadmap. **Ce fichier est la source de vérité** : toute PR doit faire avancer un item de la roadmap ci-dessous, et le mettre à jour.
>
> Dernière mise à jour : 2026-10-13 · Phase 1 (hors wallet) faite sur `claude/focused-clarke-5s4k4i`

---

## 1. Vision

**Meridian est un terminal DeFi « prompt-to-trade » : tu décris ce que tu veux en langage naturel, Meridian trouve la meilleure exécution on-chain et te la fait signer en sécurité.**

> « Place 1 000 USDC au meilleur rendement sûr » → Meridian compare Aave / Compound / Morpho sur les chaînes supportées, propose le meilleur, bridge si nécessaire, simule, puis tu signes.

### Pour qui
Un utilisateur DeFi déjà équipé d'un wallet (MetaMask, Rabby…) qui gère quelques milliers à quelques centaines de milliers de dollars sur plusieurs chaînes et qui en a marre de jongler entre 10 interfaces.

### La promesse (ce qui doit être vrai pour que le produit ait de la valeur)
1. **Comprendre** : l'intention en langage naturel devient un plan clair (quoi, où, combien, pourquoi).
2. **Comparer** : données live (prix, APY, TVL, risque), meilleure route (deBridge vs LI.FI).
3. **Exécuter sans risque** : Meridian ne signe jamais à ta place, ne fait jamais confiance à une adresse venant d'un LLM ou d'une API, simule avant de signer.
4. **Suivre** : le portefeuille se met à jour après exécution, l'historique est conservé.

### Ce que Meridian n'est PAS (non-objectifs)
- Pas un wallet, pas de custody, pas de clés privées côté serveur.
- Pas un bot de trading autonome : chaque transaction est signée par l'utilisateur.
- Pas (pour l'instant) une plateforme de perps : les perps sont un module secondaire, pas le cœur.

---

## 2. État réel (vérifié le 2026-10-12)

| Brique | État | Preuve |
|---|---|---|
| 3 MCP (deBridge, LI.FI, Aave) | ✅ fonctionnels | `/api/mcp?action=health` → 3/3 healthy |
| Prix live (30 tokens) | ✅ | `/api/prices` |
| Rendements (Aave, Compound, ~12 chaînes) | ✅ | `/api/best-yield?symbol=USDC` |
| Alpha (DefiLlama) | ✅ | `/api/alpha` |
| Devis bridge comparés deBridge vs LI.FI | ✅ | ARB→BASE 10 USDC : LI.FI 9,97 vs deBridge 9,68, LI.FI choisi |
| Rate limit API + mot de passe bêta | ✅ | PR #16, testé en local |
| Mobile | 🟡 codé, jamais vu sur téléphone | PR #16 |
| Chat IA (`parse-intent`, OpenRouter / Gemini Flash) | ✅ vérifié en prod | 3 prompts types, 3 stratégies chacun |
| Exécution (validation → approve exact → simulation → signature) | 🟡 prouvée sur un fork de Base (vrais contrats Aave/USDC), **pas encore avec un vrai wallet** | CI `fork` + tests unitaires |
| Positions utilisateur | 🟡 non vérifiées | liste vide sur l'adresse de test |
| Coffres earn LI.FI | ✅ données live (clé ajoutée le 2026-10-13, APY corrigés : l'API renvoie des %) | `/api/haiku?action=yields` |
| Routes deBridge avec swap | ❌ refusées | CrosschainForwarder hors allowlist (volontaire) |
| Portefeuille sans wallet | ✅ affiche « — » et invite à connecter un wallet (faux portefeuille supprimé) | Phase 1 |

**En une phrase : les données marchent, l'exécution est construite mais n'a jamais été prouvée de bout en bout.** Tant qu'une vraie transaction n'est pas passée, le produit n'est pas « fonctionnel ».

---

## 3. Pourquoi on a l'impression de ne pas avancer

Diagnostic honnête du code (≈ 22 000 lignes, 80 commits, 16 PR) :

1. **Trop large, pas assez profond.** Le produit annonce 16 chaînes, 20+ protocoles, 4 venues de perps (Hyperliquid, Extended, Ondo, Lighter), Solana, Base/Aerodrome/Moonwell, Haiku… mais **aucun parcours n'a été validé de bout en bout**. Chaque PR ajoute de la surface au lieu de terminer un parcours.
2. **Pas de « definition of done ».** « Ça build et les tests passent » a été traité comme « ça marche ». La seule preuve qui compte (une transaction réelle confirmée et visible dans le portefeuille) n'a jamais été faite.
3. **Plusieurs implémentations de la même chose.**
   - **Exécution : 4 chemins parallèles.** `useExecuteOrder` + `ValidatedExecuteButton` (le bon, avec simulation et allowlist), `useExecute` (ancien, encore utilisé pour le claim Lido), `useStrategyExecutor` (multi-legs, **sans simulation ni lecture d'allowance** : il approuve et envoie directement), plus les chemins perps séparés.
   - **MCP : 3 couches.** `lib/mcp/*.ts` (implémentation), `lib/mcp/providers/*` (adaptateurs), `lib/mcp/router.ts` (comparaison).
   - **Intent : 3 parseurs.** `tradePlan.ts` (règles, 825 lignes), `routeThesis.ts`, `intentEngine.ts` (LLM).
4. **Code mort qui brouille la lecture** : `lib/orchestrator.ts`, `lib/mcp/index.ts`, `lib/mcp/providers/index.ts`, `lib/integrations/index.ts`, `lib/heroArt.ts`, `hooks/useBaseMcp.ts`, `hooks/useLiveFeed.ts`, `hooks/useReveal.ts`, le composant `ExecuteButton` de `ThreadCard` (0 usage).
5. **Un fichier monstre** : `components/ThreadCard.tsx` (1 730 lignes) mélange affichage, résolution d'ordres et 9 boutons d'exécution différents.
6. **Rien ne mesure l'avancement** : pas de roadmap écrite, pas de critère de sortie. Ce document corrige ça.

> **Mise à jour Phase 1 (2026-10-13)** : les points 3, 4 et 5 sont traités — un seul chemin d'exécution, code mort supprimé, `ThreadCard` découpé. Le point 1 (prouver un parcours en vrai) reste la Phase 0, qui demande ton wallet.

---

## 4. Architecture

### 4.1 Vue d'ensemble

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

### 4.2 Modules clés

| Couche | Fichiers | Rôle |
|---|---|---|
| UI | `app/page.tsx`, `components/ThreadCard.tsx`, `components/thread/*`, `components/execute/*`, `components/*Panel.tsx` | Terminal 3 colonnes, fil de conversation, boutons d'exécution par venue, panneaux |
| Intent | `lib/intentEngine.ts`, `app/api/parse-intent`, `lib/tradePlan.ts` | Texte → `TradePlan` |
| Résolution | `lib/assetMap.ts`, `lib/quote.ts` | `TradeLeg` → `Order` (montants exacts, prix live) |
| Exécution | `lib/execution.ts`, `lib/executionPlan.ts`, `lib/orderRunner.ts`, `hooks/useExecuteOrder.ts`, `hooks/useStrategyExecutor.ts`, `components/ValidatedExecuteButton.tsx`, `components/ConfirmDialog.tsx` | `Order` → transaction validée, simulée, signée |
| Sécurité | `lib/onchain.ts`, `lib/mcp/routerAllowlist.ts`, `lib/safety.ts` | Allowlist d'adresses, garde-fou HF |
| Routage | `lib/mcp/router.ts`, `lib/mcp/{debridge,lifi}.ts` | Devis comparés, tx de bridge/swap |
| MCP | `lib/mcp/client.ts`, `lib/mcp/aave.ts` | Client MCP robuste (timeouts, coercition, replis) |
| Portefeuille | `hooks/useLivePortfolio.ts`, `app/api/positions` | Soldes et positions on-chain |
| Infra | `proxy.ts`, `lib/rateLimit.ts`, `lib/betaGate.ts`, `lib/features.ts` | Rate limit, accès bêta, feature flags |

### 4.3 Invariants de sécurité (non négociables)

1. **Aucune adresse de contrat ne vient d'un LLM ou d'une API.** Les cibles de transaction viennent de `onchain.ts` (protocoles) ou `routerAllowlist.ts` (routeurs LI.FI Diamond / deBridge DlnSource).
2. **Approbations au montant exact**, jamais illimitées ; allowance lue on-chain avant.
3. **Simulation avant signature.** Une simulation qui échoue bloque.
4. **Health factor** : tout borrow/withdraw Aave simulé ; refus sous 1,10.
5. **Meridian ne signe jamais** : le serveur ne détient aucune clé.
6. **Un seul chemin d'exécution** : tout ordre wallet passe par `lib/orderRunner.ts` (via `useExecuteOrder` ou `useStrategyExecutor`). Seuls les perps (signatures EIP-712 / StarkEx propres à chaque venue) ont leur propre chemin, et ils sont désactivés par défaut.

### 4.4 Configuration (Vercel)

| Variable | Rôle | État |
|---|---|---|
| `OPENROUTER_API_KEY` | Chat IA | Production uniquement |
| `BETA_PASSWORD` | Accès bêta | présent (sensible, production) ; `NEXT_PUBLIC_BETA_PASSWORD` obsolète, à supprimer |
| `LIFI_API_KEY` | Coffres earn LI.FI + quotas LI.FI | présente (sensible, production + preview) |
| `BLOB_READ_WRITE_TOKEN` | Stockage | présent |
| RPC dédiés | Fiabilité des lectures | **absents** (RPC publics par défaut) |

---

## 5. Roadmap

Règle : **on ne commence pas une phase tant que la précédente n'a pas atteint son critère de sortie.**

### Phase 0 — Prouver le parcours d'or (cette semaine)

**Objectif : une vraie transaction, de bout en bout, sur un seul parcours.**

Parcours d'or : *« Place 100 USDC sur Aave sur Base »* → plan affiché → signature → position visible dans le portefeuille.

- [x] Mot de passe bêta : nouveau `BETA_PASSWORD` (sensible, production) ; l'ancien `NEXT_PUBLIC_BETA_PASSWORD` est ignoré (à supprimer dans Vercel)
- [x] Chat IA vérifié en prod (2026-10-13) : connexion bêta OK, 3 prompts → 3 stratégies chacun en 5–20 s
- [x] Bug corrigé : chaque étape du plan porte sa chaîne (`leg.chain`) ; l'ordre est construit sur cette chaîne (et non celle du wallet), le bouton propose « Switch wallet to Base » si besoin
- [ ] Exécuter le parcours d'or avec un vrai wallet, petit montant (**toi**)
- [ ] Corriger tout ce qui casse pendant ce test (**moi**, sur retour d'erreur)
- [ ] Vérifier que la position Aave apparaît après confirmation
- [x] Remplacer le faux portefeuille de 128 400 $ par un état « connecte ton wallet » clair (Phase 1)
- [x] Preuve sans wallet : le parcours d'or exécuté par le vrai code contre les vrais contrats Aave + USDC sur un **fork de Base** en CI (`e2e/aaveSupply.fork.test.ts`, aucun argent réel). *Preuve : CI run [38393651681](https://github.com/Edoouuard/meridian-terminal/actions/runs/38393651681) — approve exact → supply → `CONFIRMED`, allowance consommée à 0, collatéral ≈ 100 $ visible dans Aave ; refus avant signature si solde insuffisant.* Ne remplace pas le test avec ton wallet (UI, wallet, réseau réel), mais la logique d'exécution est prouvée.
- [x] Bug corrigé (retour du test wallet) : « morpho supply requires a vaultAddress » / « deBridge order requires routerTx » — les étapes Morpho, bridge, Uniswap et perps passent par leur bouton dédié (données live : coffre ≥ 1 M$ TVL, route cotée, prix) ; « Execute Strategy » n'apparaît que si toutes les étapes sont signables ; le bridge cote de `leg.chain` vers `leg.toChain` (PR #20)
- [x] Preuve sans wallet du bridge : devis live deBridge + LI.FI → même constructeur d'ordre que le bouton (`lib/bridgeOrder.ts`) → vrai `orderRunner` sur un **fork d'Arbitrum** en CI (`e2e/bridge.fork.test.ts`) : approve exact au routeur vérifié, calldata acceptée on-chain, 5 USDC sortis du wallet, allowance à 0. *Preuve : CI run [38428480844](https://github.com/Edoouuard/meridian-terminal/actions/runs/38428480844).* L'arrivée sur Base (remplie par le bridge) reste à voir avec ton wallet.
- [x] Position visible : le portefeuille lit `getUserAccountData` du pool Aave Base (le même appel vérifié par la preuve fork) et se rafraîchit après chaque confirmation
- [ ] Deuxième parcours : bridge 5 USDC Arbitrum → Base (**toi**)

**Critère de sortie :** 2 transactions réelles confirmées (supply Aave + bridge), visibles dans l'app, sans intervention manuelle.

### Phase 1 — Consolider (1 à 2 semaines)

**Objectif : moins de code, un seul chemin, un code lisible.**

- [x] Un seul chemin d'exécution : `lib/orderRunner.ts` (prépare → simule → signe), utilisé par `useExecuteOrder` **et** `useStrategyExecutor`. Les stratégies multi-legs sont désormais vérifiées (solde, allowance, simulation) avant chaque signature, et chaque leg utilise le client de sa propre chaîne. *Preuve : 9 tests unitaires `orderRunner.test.ts` (wallet et chaîne simulés).*
- [x] Claim Lido migré sur le chemin validé ; `useExecute` et l'`ExecuteButton` inutilisé supprimés ; `explorerUrlFor` → `lib/explorer.ts`
- [x] Code mort supprimé : ~3 000 lignes nettes (orchestrator, policy, broadcast, feeds, registre perps + stubs, barrels, hooks inutilisés, données démo, `/api/swap` sans appelant, fonctions MCP mortes)
- [x] `ThreadCard.tsx` découpé : 1 730 → 295 lignes (`components/execute/*`, `components/thread/*`)
- [x] Couches MCP fusionnées : un module par fournisseur (`lib/mcp/{client,aave,debridge,lifi,router}.ts`) ; `providers/` ne garde que Haiku et Base
- [x] Surface réduite par flags (`lib/features.ts`) : perps et Solana masqués par défaut (`NEXT_PUBLIC_FEATURE_PERPS=1` / `NEXT_PUBLIC_FEATURE_SOLANA=1` pour les réactiver) ; le chat ne propose plus de perps tant qu'ils sont coupés
- [ ] Chaînes secondaires : **non fait** — masquer des chaînes cache aussi les fonds de l'utilisateur sur ces chaînes dans le portefeuille ; décision à prendre (D1)
- [x] Double comptage Haiku corrigé : Haiku relisait les mêmes soldes (LI.FI) et positions Aave (Aave MCP) ; seules ses positions hors protocoles déjà suivis sont ajoutées
- [x] Bug démo corrigé : un wallet connecté sans staking affichait 42 % de concentration staking (valeur démo)
- [x] `LIFI_API_KEY` ajoutée dans Vercel (production + preview) ; bug d'unité des APY earn corrigé (×100)
- [x] Coffres earn : jamais proposés sous **1 M$ de TVL** (`MIN_VAULT_TVL_USD`, appliqué au chat et à `/api/haiku?action=yields`)
- [x] Audit protocole × chaîne × action (560 combinaisons) + audit on-chain de toutes les adresses (`npm run audit:onchain`, workflow dédié) : prix WETH manquant, alias MATIC→WETH, adresses fausses (wstETH OP, USDC Mantle, AAVE Avalanche, Uniswap Scroll/Linea), checksums invalides, Uniswap multi-niveaux de frais, venues sans contrat retirées
- [x] Plan ajusté au wallet (`lib/fundingPlanner.ts`) : chaque étape est financée par les soldes réels — bridge ajouté depuis la chaîne où sont les fonds, étape gardée sur place si le bridge ne se rembourse pas en 90 jours de rendement en plus (devis live + APY DefiLlama), montant réduit sinon ; l'étape suivant un bridge attend l'arrivée des fonds (`FundsArrivalGate`)

**Critère de sortie :** un seul hook d'exécution, `ThreadCard` < 500 lignes, aucun module mort, les parcours de la Phase 0 passent toujours.

### Phase 2 — Bêta privée (2 à 3 semaines)

**Objectif : 5 à 10 utilisateurs réels sans que tu sois derrière eux.**

- [ ] RPC dédiés (Alchemy / Infura) pour les chaînes gardées
- [ ] Observabilité : journal serveur des exécutions (succès / échec / raison), suivi d'erreurs (Sentry ou équivalent)
- [ ] Rate limit strict via Vercel WAF (le limiteur actuel est par instance)
- [x] Test e2e automatisé du parcours d'or sur un fork (Anvil) en CI — voir Phase 0
- [x] CI GitHub : lint + typecheck + tests + build sur chaque push (`.github/workflows/ci.yml`)
- [ ] Onboarding : 3 prompts suggérés, états vides propres, messages d'erreur compréhensibles
- [ ] Décision deBridge CrosschainForwarder (routes avec swap)

**Critère de sortie :** 10 utilisateurs, ≥ 20 transactions réelles, taux d'échec < 10 % avec cause connue pour chaque échec.

### Phase 3 — Produit (après la bêta)

Seulement une fois la bêta stable, selon les retours :
- Stratégies multi-legs (rotation de rendement, delta neutre) sur le chemin unique
- Bridge + dépôt en un parcours (« place mes USDC d'Arbitrum sur le meilleur rendement de Base »)
- Alertes (health factor, APY qui chute)
- Réintégration progressive des perps et de Solana, un par un, chacun avec son parcours d'or
- Monétisation (hypothèse à valider) : frais d'intégrateur LI.FI / deBridge sur les routes

---

## 6. Décisions ouvertes (à trancher par toi)

| # | Décision | Recommandation |
|---|---|---|
| D1 | Réduire la surface visible (masquer perps / Solana / chaînes secondaires) ? | **Oui**, derrière un flag : on réactive ce qui est prouvé |
| D2 | Ajouter le deBridge CrosschainForwarder à l'allowlist ? | Pas avant la Phase 2 : le bridge simple suffit |
| D3 | Créer une `LIFI_API_KEY` ? | Oui, gratuit, débloque les coffres earn |
| D4 | Modèle LLM du chat (Gemini Flash aujourd'hui) | Garder tant que le parcours d'or n'est pas validé |

---

## 7. Règles de travail

1. **Une PR = un item coché de cette roadmap.** Pas de PR « fourre-tout ».
2. **Done = prouvé**, pas « ça build » : chaque item dit comment il a été vérifié (test, capture, hash de transaction).
3. **Pas de nouvelle fonctionnalité** tant que la phase en cours n'a pas atteint son critère de sortie.
4. **Ce fichier est mis à jour dans la même PR** que le travail (cases cochées, tableau d'état §2).
