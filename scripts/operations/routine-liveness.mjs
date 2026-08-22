#!/usr/bin/env node
// routine-liveness.mjs — SWY-992 (v1, workspace CEO) → SWY-997 (v2, /paperclip/bin)
//
// ── POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST ICI ───────────────────────────────
//
// `routine-watchdog.mjs` fait la détection par routine. Il est HÉBERGÉ par la routine
// `d38d4a59`, dont l'assignee est Alex. Quand Alex est non-invocable, l'ordonnanceur refuse
// le tir AVANT que le script ne démarre : le garde est muet exactement dans le cas qu'il
// doit signaler. Mesuré : 65 tirs refusés d'affilée, 2026-07-30T22:00:20Z →
// 2026-08-05T06:00:16Z, 0 écart ≠ 2 h, ZÉRO alerte. La routine n'a jamais réussi que 2 fois,
// toutes deux le jour de sa création.
//
// Contrainte de conception, énoncée sans détour : **une détection hébergée par une routine
// ne peut pas couvrir sa propre routine.** Ce script-ci n'a AUCUNE dépendance de routine —
// il ne lit que la base du control plane et tourne depuis le heartbeat ORDINAIRE de
// n'importe quel agent vivant, quelle qu'en soit la cause de réveil (`issue_assigned`,
// `issue_commented`, `heartbeat_timer`, `issue_blockers_resolved`, …). C'est ce qui le
// distingue du watchdog : le chemin d'invocation planifiée a produit 0 vivant sur 65 tirs,
// alors que le heartbeat ordinaire, lui, a continué de livrer pendant toute la fenêtre.
//
// v2 — POURQUOI IL A DÉMÉNAGÉ DANS /paperclip/bin. La v1 ne vivait que dans le workspace de
// l'agent `a8910721` (Chris). C'est EXACTEMENT le second point unique de panne que SWY-991
// avait corrigé pour `routine-watchdog.mjs` : un garde hôte-indépendant qui n'existe que
// sur un hôte ne l'est pas. `/paperclip/bin` est le chemin canonique partagé, lisible par
// tous les agents de l'instance.
//
// ── CE QUI A CHANGÉ EN v2, ET CE QUE ÇA CORRIGE ─────────────────────────────────────
//
// 1. LE TIR MANUEL NE COMPTE PLUS COMME PREUVE DE VIE (SWY-994 → SWY-1003). La v1 lisait
//    `status='completed'` toutes sources confondues. Or le tir manuel est précisément le
//    geste qu'on fait *parce que* l'ordonnanceur ne livre plus : la règle est éteinte par la
//    COMPENSATION de la panne qu'elle surveille. Mesuré sur `d38d4a59` le 2026-08-05T07:20Z :
//      toutes sources → dernier tir vivant 2026-08-05T07:02:00Z (0,3 h) → muet
//      source=schedule → dernier tir vivant 2026-07-30T20:00:19Z (131 h) → CRITICAL
//    Les deux chiffres sont désormais IMPRIMÉS SÉPARÉMENT : leur écart EST le signal.
//
// 2. `paused_at` NE CORROBORE PAS LA PAUSE QUI NOUS INTÉRESSE. Mesuré le 2026-08-05 :
//      Architecte  paused/manual            paused_at=2026-07-26T08:08:08Z   ⇒ renseigné
//      Maya        paused/manual            paused_at=2026-07-18T08:32:44Z   ⇒ renseigné
//      Lena        paused/manual            paused_at=2026-07-01T15:59:01Z   ⇒ renseigné
//      Jordan      paused/pause_reason=NULL paused_at=NULL                   ⇒ MUET
//      Alex        paused/pause_reason=NULL paused_at=NULL (pendant le gel)  ⇒ MUET
//    Les pauses du quota guardian n'écrivent NI `pause_reason` NI `paused_at`. Toute règle
//    qui exige `paused_at` pour condamner est donc aveugle à la SEULE classe de pause qui
//    produit ce mode de panne. C'est ce qui rendait `R1_DEAD_ASSIGNEE` du watchdog
//    inopérant sur le gel de 5,4 j — il retombait en `R1_STATUS_UNCORROBORATED` (WARN).
//    Ici, le discriminant est `pause_reason`, pas `paused_at`.
//
// 3. LE SIGNAL PLATEFORME EST LU. Chaque refus d'invocation écrit une ligne
//    `agent_wakeup_requests(reason='agent.not_invokable', status='skipped')`. Aucune route
//    d'API ne l'expose (vérifié : aucun `grep agent_wakeup_requests` dans server/src/routes),
//    et RIEN ne le lisait. C'est pourtant le détecteur le moins cher possible, et il est
//    strictement plus riche que `routine_runs` : mesuré sur 168 h, 130 refus dont
//    `source=assignment` 100 (des ISSUES qui n'ont pas pu réveiller leur assignee — invisible
//    dans `routine_runs`) et `source=automation` 30 (les tirs de routine).
//
// ── CE QU'IL NE FAIT PAS ────────────────────────────────────────────────────────────
//
// Il n'ouvre pas d'issue et ne dédoublonne pas — c'est le rôle de `routine-watchdog.mjs`.
// Il répond à trois questions et s'arrête là : quelles routines sont mortes, laquelle se
// soignera toute seule, et le chemin PLANIFIÉ livre-t-il encore quoi que ce soit.
//
// ── SWY-1523 : IL NE CONNAISSAIT PAS LE VOCABULAIRE DES TIRS REPEINTS ───────────────
//
// Défaut mesuré le 2026-08-17 : `grep -inE "moved to|disposal|disposition"` rendait **0 ligne
// sur 613**. La plateforme repeint la ligne d'un tir quand la carte d'exécution qu'il a créée
// change d'état après coup (`services/routines.ts:2763`) ; ce fichier comptait donc les 5
// lignes repeintes de la company comme des tirs NON ABOUTIS, et `cancelled` comme `blocked`.
// Les deux colonnes `TENTÉS / ABOUTIS` — celles que le manager cite comme preuve de vivacité
// de l'ordonnanceur — étaient fausses dans le sens qui rassure le moins : elles montraient des
// morts là où le travail avait été livré.
//
// Le vocabulaire vit maintenant dans `./routine-run-disposition.mjs`, PARTAGÉ avec
// `routine-watchdog.mjs` : deux copies auraient divergé au libellé suivant, ce qui est
// littéralement le défaut réparé (le watchdog connaissait `cancelled`, celui-ci rien).
// Table sémantique : `moved to blocked` = tir ABOUTI (la carte prouve la livraison) ;
// `moved to cancelled` = EXCLU des deux populations (ni abouti, ni non délivré) ; tout autre
// état = ÉCHEC + un cri. Les comptes par statut sont donc désormais faits EN JS sur les runs
// bruts, et non plus par des agrégats SQL : le classement doit exister à UN seul endroit, et
// il doit être rejouable hors base par `--self-test`.
//
// Usage : node /paperclip/bin/routine-liveness.mjs [--json] [--window-hours 168]
//                                                  [--fleet-stale-hours 26]
//                                                  [--assume-armed] [--refusal-control]
//                                                  [--self-test]
// Env   : DATABASE_URL, PAPERCLIP_COMPANY_ID (inutiles pour `--self-test`)
// Sortie: 0 = tout vivant | 1 = mort AUTO-RÉPARABLE seulement | 2 = au moins un TERMINAL
//         (ou la flotte n'a plus aucun tir planifié vivant)
//
// DEUX colonnes de jugement par routine, disjointes (SWY-1085) :
//   verdict → l'ASSIGNEE : ROUTINE_INACTIVE NO_ASSIGNEE DEAD_TERMINAL LIVE LIVE_AFTER_THAW
//                          DEAD_SELF_HEALING
//   chemin  → le CHEMIN PLANIFIÉ : PATH_NEVER (aucun tir planifié abouti, jamais)
//                                  PATH_STALE (> --fleet-stale-hours) | PATH_OK
// `LIVE PATH_NEVER` est un état réel et fréquent : assignee joignable, cron qui n'a jamais
// livré. Une ligne citée sans sa seconde colonne ne dit pas si le tick est porté.

import { createRequire } from "node:module";
// SWY-1523 — vocabulaire des tirs REPEINTS, partagé avec `routine-watchdog.mjs`.
import {
  classifyRunDisposition,
  DISPOSITION_DELIVERED_STATES,
  DISPOSITION_EXCLUDED_STATES,
  DISPOSITION_VOCAB,
  DISPOSITION_VOCAB_ABLATED,
} from "./routine-run-disposition.mjs";

// Résolution du driver : `postgres` n'est pas une dépendance de ce script (il n'a pas de
// package.json à lui). On passe par le node_modules de l'app, en essayant d'abord le
// specifier nu — si un jour le hash pnpm change, le chemin en dur ne casse plus tout.
const require_ = createRequire("/app/server/index.js");
// SWY-1523 — résolution DIFFÉRÉE (elle était faite au chargement du module). Le `--self-test`
// ajouté par cette carte est hors ligne par construction ; le faire dépendre du node_modules
// de l'app en ferait un test qu'on ne peut pas rejouer là où le driver n'est pas installé.
function loadPostgres() {
  let pg;
  try {
    pg = require_("postgres");
  } catch {
    pg = require_("/app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cjs/src/index.js");
  }
  return pg.default ?? pg;
}

// Lu dans /app/packages/shared/src/agent-eligibility.ts:58-69 (pas déduit d'une mesure) :
//   INVOKABLE = {active, idle, running, error} \ {terminated, pending_approval, paused}
// et /app/server/src/services/agent-invokability.ts:88-98 émet le message
//   "Agent is not invokable in its current state"
// SI ET SEULEMENT SI le status PROPRE de l'agent est paused|terminated|pending_approval|
// inconnu. Une chaîne hiérarchique cassée donne un AUTRE message.
const INVOKABLE = new Set(["active", "idle", "running", "error"]);
const NON_INVOKABLE = new Set(["terminated", "pending_approval", "paused"]);
const isInvokable = (s) => INVOKABLE.has(s) && !NON_INVOKABLE.has(s);

// `terminated` est le seul non-invocable IRRÉVERSIBLE : l'agent est sorti de l'org chart.
const IRREVERSIBLE = new Set(["terminated"]);

// SWY-1669 — l’état de l’assignee ne condamne pas, à lui seul, un chemin qui livre.
// `terminated` reste irréversible et terminal quel que soit le chemin. Pour une pause
// manuelle, il faut la CONJONCTION avec une non-livraison mesurée.
function assigneeVerdict({ routineStatus, disarmed, hasAssignee, agentStatus, invokable,
  failedStreak, pauseReason, scheduledPathDead, undeliveredStreak }) {
  if (routineStatus !== "active") return "ROUTINE_INACTIVE";
  if (disarmed) return "ROUTINE_DISARMED";
  if (!hasAssignee) return "NO_ASSIGNEE";
  if (IRREVERSIBLE.has(String(agentStatus))) return "DEAD_TERMINAL";
  if (invokable && failedStreak === 0) return "LIVE";
  if (invokable) return "LIVE_AFTER_THAW";
  if (pauseReason === "manual") {
    return scheduledPathDead || undeliveredStreak > 0 ? "DEAD_TERMINAL" : "PATH_DELIVERING";
  }
  return "DEAD_SELF_HEALING";
}

// SWY-1268 — LE MESSAGE DE REFUS EST UN DISCRIMINANT, PAS UN CONSTAT VAGUE. Le texte exact
// ci-dessous ne sort que d'`agent-invokability.ts:94`, atteint UNIQUEMENT quand le statut
// PROPRE de l'agent vaut paused|terminated|pending_approval, ou est hors vocabulaire. Or
// `running` et `idle` sont tous deux invocables (`agent-eligibility.ts:60`,
// INVOKABLE_AGENT_STATUSES). **Un agent OCCUPÉ ne produit donc JAMAIS ce message** : la
// contention, elle, produit `skipped`/`coalesced` via la concurrencyPolicy — pas `failed`.
// Lire ce message comme « l'hôte était occupé » est l'erreur que ce garde doit rendre
// impossible : voir `refusalsDuringActiveRun` plus bas, qui la mesure au lieu de l'affirmer.
const NOT_INVOKABLE_MSG = "not invokable in its current state";

// Statuts de run qui signent un créneau planifié NON DÉLIVRÉ, et leurs causes DISJOINTES
// (`services/routines.ts:187-191`, `:1133`, `:1515`) :
//   failed    → l'invocation a été refusée (failure_reason porte la cause)
//   skipped   → soit le projet est en pause (failure_reason renseigné), soit une issue
//               d'exécution VIVANTE existe déjà (failure_reason null, concurrencyPolicy
//               `skip_if_active`) — dans ce second cas l'hôte n'est pas en cause du tout
//   coalesced → fondu dans une issue d'exécution vivante (`always_enqueue` exclu)
// Les trois sont des NON-LIVRAISONS. Les confondre avec `failed` seul est ce qui rendait le
// compteur aveugle (SWY-1268) ; les fusionner sans les nommer ferait pointer le mauvais
// remède (dégeler un hôte vs. fermer une issue d'exécution échouée).
const RUN_UNDELIVERED = ["failed", "skipped", "coalesced"];

// Statuts de run comptés comme « le tir a ABOUTI ». Repris de
// packages/shared/src/constants.ts:509 (ROUTINE_RUN_STATUSES, six valeurs) :
//   `issue_created` = l'issue d'exécution existe ⇒ le tir a abouti (services/routines.ts:1617).
//   `completed`     = l'issue est passée `done` plus tard (services/routines.ts:2748).
// `received`/`skipped`/`coalesced` ne prouvent ni la vie ni la mort. `failed` condamne.
const RUN_LIVE = ["completed", "issue_created"];

// ═════════════════════════════════════════════════════════════════════════════════════
// SWY-1523 — LE CLASSEMENT DES TIRS, EN JS, À UN SEUL ENDROIT, TESTABLE HORS BASE
// ═════════════════════════════════════════════════════════════════════════════════════
//
// Les comptes étaient faits par des agrégats SQL (`status IN (...)`, `count(*) FILTER`), donc
// le vocabulaire aurait dû être recopié dans chaque requête. C'est précisément ainsi qu'un
// libellé neuf passe inaperçu — et une logique qui vit dans du SQL ne se rejoue pas hors base,
// donc ne se teste pas. Les runs sont désormais lus BRUTS (une requête pour toute la company,
// 365 lignes mesurées le 2026-08-17 : le coût est nul) et classés ici.
//
// Le classement rend TROIS familles, et les trois sont imprimées — un tir retiré d'une
// population sans être compté ailleurs est un tir qui disparaît en silence :
//   `counted:true , status normalisé`  -> le tir compte, dans la population de son statut
//   `counted:false`                    -> EXCLU (disposition ambiguë : annulation)
//   `unknownDisposition:true`          -> ÉCHEC, et le garde le CRIE (état hors table)

/**
 * Statut du TIR, débarrassé de ce qu'une disposition postérieure a écrit dessus.
 * @param {{status?: string, failure_reason?: string|null, linked_issue_id?: string|null}} run
 * @returns {{status: string, counted: boolean, klass: string, state: string|null,
 *            unknownDisposition: boolean, malformedDisposition: boolean}}
 */
function normalizeRun(run, vocab = DISPOSITION_VOCAB) {
  const d = classifyRunDisposition(run, vocab);
  const raw = String(run?.status ?? "");
  if (d.klass === "delivered") {
    // Le tir a abouti : la carte EXISTE et un agent l'a prise. C'est le statut d'AVANT la
    // repeinture (`issue_created`, services/routines.ts:1617) qui vaut.
    return { status: "issue_created", counted: true, klass: d.klass, state: d.state,
             unknownDisposition: false, malformedDisposition: false };
  }
  if (d.klass === "excluded") {
    // Ni abouti, ni non délivré. On perd de la SENSIBILITÉ (un vrai créneau perdu peut se
    // cacher derrière une annulation), jamais de la SPÉCIFICITÉ — et c'est le sens choisi par
    // la table sémantique de SWY-1523, parce qu'une carte annulée ne témoigne plus de rien.
    return { status: raw, counted: false, klass: d.klass, state: d.state,
             unknownDisposition: false, malformedDisposition: false };
  }
  return { status: raw, counted: true, klass: d.klass, state: d.state,
           unknownDisposition: d.klass === "unknown", malformedDisposition: d.klass === "none" && d.formish };
}

/** Vue normalisée d'une ligne de `routine_runs`, indépendante du driver. */
function viewRun(run, vocab = DISPOSITION_VOCAB) {
  const n = normalizeRun(run, vocab);
  const at = run?.triggered_at ?? run?.triggeredAt ?? null;
  return {
    routineId: String(run?.routine_id ?? run?.routineId ?? ""),
    source: String(run?.source ?? ""),
    at: at ? new Date(at).toISOString() : null,
    reason: run?.failure_reason ?? run?.failureReason ?? null,
    ...n,
  };
}

/** Le plus grand `at` d'un ensemble de vues, ou `null`. */
function maxAt(views) {
  return views.reduce((m, v) => (v.at && (m === null || v.at > m) ? v.at : m), null);
}

/**
 * Audit des REPEINTURES sur un ensemble de vues. Sort à CHAQUE passage, y compris à zéro :
 * « aucune ligne repeinte » et « je ne sais pas les lire » doivent être distinguables.
 */
function repaintAudit(views) {
  // Les états sont ventilés PAR CLASSE, jamais dans une seule carte : une ligne
  // « 4 EXCLUES {cancelled:4, blocked:1} » se lit « blocked est exclu », soit l'inverse de la
  // table sémantique. Défaut vu sur ma propre sortie avant de la publier.
  const byState = { delivered: {}, excluded: {}, unknown: {} };
  const bump = (bucket, state) => { byState[bucket][state] = (byState[bucket][state] ?? 0) + 1; };
  let delivered = 0;
  let excluded = 0;
  let unknown = 0;
  let malformed = 0;
  for (const v of views) {
    if (v.klass === "delivered") { delivered += 1; bump("delivered", v.state); }
    else if (v.klass === "excluded") { excluded += 1; bump("excluded", v.state); }
    else if (v.unknownDisposition) { unknown += 1; bump("unknown", v.state); }
    else if (v.malformedDisposition) malformed += 1;
  }
  return { delivered, excluded, unknown, malformed, byState };
}

/**
 * Les compteurs PAR ROUTINE, exactement ceux que les agrégats SQL rendaient — mêmes ancres,
 * mêmes portées de source, mêmes populations. Ce qui change est le classement des lignes
 * repeintes, et rien d'autre : l'ablation du point 4 de SWY-1523 le prouve.
 */
function summarizeRoutineRuns(runs, vocab = DISPOSITION_VOCAB) {
  const views = (runs ?? []).map((r) => viewRun(r, vocab)).filter((v) => v.counted);
  const live = views.filter((v) => RUN_LIVE.includes(v.status));
  const lastScheduledLiveAt = maxAt(live.filter((v) => v.source === "schedule"));
  const lastAnySourceLiveAt = maxAt(live);

  // Streak = échecs consécutifs DEPUIS le dernier tir abouti, TOUTES SOURCES (un tir manuel
  // qui aboutit remet bien le compteur d'échecs à zéro — il ne prouve simplement rien sur le
  // chemin planifié, ce que mesure `undelivered*` ci-dessous).
  const failed = views.filter((v) => v.status === "failed"
    && (lastAnySourceLiveAt === null || (v.at && v.at > lastAnySourceLiveAt)));
  const firstFailAt = failed.reduce((m, v) => (v.at && (m === null || v.at < m) ? v.at : m), null);

  // Créneaux PLANIFIÉS non délivrés depuis le dernier tir PLANIFIÉ abouti (SWY-1268).
  const undelivered = views.filter((v) => v.source === "schedule"
    && RUN_UNDELIVERED.includes(v.status)
    && (lastScheduledLiveAt === null || (v.at && v.at > lastScheduledLiveAt)));
  const undeliveredByStatus = {};
  for (const v of undelivered) undeliveredByStatus[v.status] = (undeliveredByStatus[v.status] ?? 0) + 1;

  return {
    lastScheduledLiveAt,
    lastAnySourceLiveAt,
    failedStreak: failed.length,
    firstFailAt,
    undeliveredByStatus,
    undeliveredStreak: undelivered.length,
    undeliveredSince: undelivered.reduce((m, v) => (v.at && (m === null || v.at < m) ? v.at : m), null),
    // L'audit porte sur TOUTES les vues, y compris les exclues — donc on le refait ici sur
    // l'ensemble brut, sinon les lignes retirées de la population disparaîtraient du rapport.
    repaint: repaintAudit((runs ?? []).map((r) => viewRun(r, vocab))),
  };
}

/** Les compteurs de FLOTTE. `cutoffIso` borne la fenêtre ; les deux colonnes la partagent. */
function summarizeFleetRuns(runs, cutoffIso, vocab = DISPOSITION_VOCAB) {
  const all = (runs ?? []).map((r) => viewRun(r, vocab));
  const counted = all.filter((v) => v.counted);
  const live = counted.filter((v) => RUN_LIVE.includes(v.status));
  const inWindow = (v) => v.at && v.at > cutoffIso;
  const sched = (v) => v.source === "schedule";
  return {
    lastScheduledLiveAt: maxAt(live.filter(sched)),
    lastAnySourceLiveAt: maxAt(live),
    // TENTÉS et ABOUTIS sur la MÊME population : les lignes EXCLUES sortent des DEUX. Les
    // laisser dans les TENTÉS seulement les compterait comme des tirs non aboutis — le défaut
    // exact de SWY-1523. Le compte exclu est imprimé à côté, jamais escamoté.
    scheduledAttemptedInWindow: counted.filter((v) => sched(v) && inWindow(v)).length,
    scheduledLiveInWindow: live.filter((v) => sched(v) && inWindow(v)).length,
    scheduledExcludedInWindow: all.filter((v) => !v.counted && sched(v) && inWindow(v)).length,
    repaintInWindow: repaintAudit(all.filter((v) => sched(v) && inWindow(v))),
    repaintAll: repaintAudit(all),
  };
}

// ── SWY-1523 : SELFTEST — hors ligne, hors base, rejouable par n'importe qui ───────────
//
// Ce fichier n'en avait aucun : ses deux colonnes de flotte étaient citées comme preuve sans
// qu'aucun contrôle ne puisse rougir. Les fixtures ci-dessous sont les lignes RÉELLES de la
// company, relevées le 2026-08-17T15:43Z par la requête citée sur SWY-1523 — pas des formes
// que j'aurais imaginées. La forme des clés est celle de `routine_runs` (snake_case), donc le
// banc teste EXACTEMENT ce que le driver sert.
function selftest() {
  const ablateAll = process.env.ROUTINE_DISPOSITION_ABLATE === "1";
  const bench = ablateAll ? DISPOSITION_VOCAB_ABLATED : DISPOSITION_VOCAB;
  if (ablateAll) {
    console.log("⚠ ABLATION — vocabulaire ramené à celui d'AVANT SWY-1523 (delivered={}). "
      + "Les cas qui dépendent de la normalisation DOIVENT rougir.\n");
  }
  let failures = 0;
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { console.log(`  ✓ ${name}`); return; }
    failures += 1;
    console.error(`  ✗ ${name}\n      attendu: ${JSON.stringify(want)}\n      obtenu : ${JSON.stringify(got)}`);
  };

  const row = (at, status, extra = {}) => ({
    routine_id: "b3eb1a69", source: "schedule", status,
    failure_reason: null, linked_issue_id: null, triggered_at: at, ...extra,
  });
  const refus = (at) => row(at, "failed",
    { failure_reason: "Agent is not invokable in its current state" });
  const done = (at) => row(at, "completed");
  const repainted = (at, state, card) => row(at, "failed",
    { failure_reason: `Execution issue moved to ${state}`, linked_issue_id: card });

  // Les 9 tirs RÉELS de `b3eb1a69` : la repeinture `blocked` du 17/08, le tir drainé du 14/08,
  // puis les 7 refus « Agent is not invokable in its current state » (aucun porteur de carte).
  const b3eb1a69 = [
    repainted("2026-08-17T06:00:28.534Z", "blocked", "iss-SWY-1491"),
    done("2026-08-14T06:00:15.362Z"),
    refus("2026-08-13T06:00:01.446Z"), refus("2026-08-12T06:00:28.272Z"),
    refus("2026-08-11T06:00:14.487Z"), refus("2026-08-10T06:00:10.064Z"),
    refus("2026-08-07T06:00:23.035Z"), refus("2026-08-06T06:00:18.222Z"),
    refus("2026-08-03T06:00:07.220Z"),
  ];
  // Les 4 annulations RÉELLES de `83f3bf08` (13-14/08) et son tir drainé du 12/08.
  const cancelledFires = [
    repainted("2026-08-14T10:40:16.018Z", "cancelled", "iss-SWY-1338"),
    repainted("2026-08-14T04:40:14.952Z", "cancelled", "iss-SWY-1324"),
    repainted("2026-08-13T22:40:13.953Z", "cancelled", "iss-SWY-1321"),
    repainted("2026-08-13T16:40:13.118Z", "cancelled", "iss-SWY-1319"),
  ];

  // ── 1. Le classement, ligne par ligne ────────────────────────────────────────────────
  const klassOf = (r, v = bench) => {
    const n = normalizeRun(r, v);
    return { klass: n.klass, status: n.status, counted: n.counted, unknown: n.unknownDisposition };
  };
  check("POSITIF — `moved to blocked` + carte : tir ABOUTI (statut d'avant la repeinture)",
    klassOf(b3eb1a69[0]),
    { klass: "delivered", status: "issue_created", counted: true, unknown: false });
  check("NÉGATIF NOMINAL — refus RÉEL de l'ordonnanceur : reste un ÉCHEC compté",
    klassOf(refus("2026-08-13T06:00:01.446Z")),
    { klass: "none", status: "failed", counted: true, unknown: false });
  check("NÉGATIF FRONTIÈRE — `moved to cancelled` : EXCLU des populations (counted=false)",
    klassOf(cancelledFires[0]),
    { klass: "excluded", status: "failed", counted: false, unknown: false });
  check("INCONNU — `moved to zzz` : reste un ÉCHEC, et le garde le signale",
    klassOf(repainted("2026-08-17T06:00:28.534Z", "zzz", "iss-SWY-1491")),
    { klass: "unknown", status: "failed", counted: true, unknown: true });
  check("INCONNU — `moved to in_review` (état SERVEUR plausible, hors table) : idem",
    klassOf(repainted("2026-08-17T06:00:28.534Z", "in_review", "iss-SWY-1491")),
    { klass: "unknown", status: "failed", counted: true, unknown: true });
  const malformed = summarizeRoutineRuns(
    [{ ...repainted("2026-08-17T06:00:28.534Z", "blocked", "iss-SWY-1491"),
       failure_reason: "Execution issue moved to blocked by the board" },
     done("2026-08-14T06:00:15.362Z")], bench);
  check("NÉGATIF FORME — motif « moved to » de gabarit inconnu : ÉCHEC compté, et SIGNALÉ",
    // La forme est ancrée aux deux bouts : un gabarit non prévu ne se fait pas blanchir. Mais
    // il ne se tait pas non plus — sinon un changement de gabarit rendrait la normalisation
    // inerte en silence, ce qui est la panne de départ dans un autre costume.
    { streak: malformed.failedStreak, undelivered: malformed.undeliveredStreak,
      malformed: malformed.repaint.malformed, delivered: malformed.repaint.delivered },
    { streak: 1, undelivered: 1, malformed: 1, delivered: 0 });
  check("NÉGATIF STRUCTUREL — libellé de disposition SANS carte : pas une repeinture",
    // Le discriminant structurel, mesuré : un refus de dispatch réel n'a jamais de carte.
    // Sans lui, un motif recopié suffirait à blanchir un vrai échec.
    klassOf({ ...repainted("2026-08-17T06:00:28.534Z", "blocked", "iss-x"), linked_issue_id: null }),
    { klass: "none", status: "failed", counted: true, unknown: false });

  // ── 2. Les compteurs PAR ROUTINE, sur les 9 tirs réels ───────────────────────────────
  const s = summarizeRoutineRuns(b3eb1a69, bench);
  check("POSITIF — `b3eb1a69` : le tir repeint est le dernier tir PLANIFIÉ abouti",
    { last: s.lastScheduledLiveAt, streak: s.failedStreak,
      undelivered: s.undeliveredStreak, byStatus: s.undeliveredByStatus,
      repaint: s.repaint.delivered },
    { last: "2026-08-17T06:00:28.534Z", streak: 0, undelivered: 0, byStatus: {}, repaint: 1 });
  const sNominal = summarizeRoutineRuns(
    [refus("2026-08-13T06:00:01.446Z"), refus("2026-08-12T06:00:28.272Z"),
     refus("2026-08-11T06:00:14.487Z"), done("2026-08-10T06:00:10.064Z")], bench);
  check("NÉGATIF NOMINAL — 3 refus réels après un tir abouti : 3 ÉCHECS, 3 créneaux NON DÉLIVRÉS",
    { streak: sNominal.failedStreak, undelivered: sNominal.undeliveredStreak,
      byStatus: sNominal.undeliveredByStatus },
    { streak: 3, undelivered: 3, byStatus: { failed: 3 } });
  const sCancel = summarizeRoutineRuns(
    [...cancelledFires, done("2026-08-12T10:40:28.641Z")], bench);
  check("NÉGATIF FRONTIÈRE — 4 annulations : ni ABOUTIES (dernier abouti = 12/08) ni ÉCHOUÉES",
    { last: sCancel.lastScheduledLiveAt, streak: sCancel.failedStreak,
      undelivered: sCancel.undeliveredStreak, excluded: sCancel.repaint.excluded },
    { last: "2026-08-12T10:40:28.641Z", streak: 0, undelivered: 0, excluded: 4 });
  const sUnknown = summarizeRoutineRuns(
    [repainted("2026-08-17T06:00:28.534Z", "zzz", "iss-SWY-1491"), done("2026-08-14T06:00:15.362Z")],
    bench);
  check("INCONNU — un état hors table ne s'avale pas : ÉCHEC compté ET signalé",
    { last: sUnknown.lastScheduledLiveAt, streak: sUnknown.failedStreak,
      undelivered: sUnknown.undeliveredStreak, unknown: sUnknown.repaint.unknown,
      byState: sUnknown.repaint.byState },
    { last: "2026-08-14T06:00:15.362Z", streak: 1, undelivered: 1, unknown: 1,
      // L'état est ventilé sous SA classe : le voir tomber dans `delivered` ou `excluded`
      // serait le bug que cette ventilation empêche.
      byState: { delivered: {}, excluded: {}, unknown: { zzz: 1 } } });

  // ── 3. Les DEUX colonnes de flotte — celles qui sont citées en rapport ───────────────
  // Population : les 13 tirs réels ci-dessus, fenêtre ouverte (cutoff antérieur à tout).
  const fleetV = summarizeFleetRuns([...b3eb1a69, ...cancelledFires], "2026-08-01T00:00:00.000Z", bench);
  check("POSITIF flotte — TENTÉS/ABOUTIS : la repeinture `blocked` compte dans les DEUX",
    { tentes: fleetV.scheduledAttemptedInWindow, aboutis: fleetV.scheduledLiveInWindow,
      exclus: fleetV.scheduledExcludedInWindow },
    // 13 lignes : 4 annulations SORTENT des deux colonnes (9 TENTÉS), et les ABOUTIS sont le
    // tir `completed` du 14/08 PLUS la repeinture `blocked` du 17/08.
    { tentes: 9, aboutis: 2, exclus: 4 });

  // ── 4. ABLATION — le vocabulaire d'AVANT, sur les MÊMES lignes ──────────────────────
  // Ce cas ne change qu'un paramètre : le vocabulaire. Les valeurs attendues ci-dessous sont
  // EXACTEMENT ce que ce fichier imprimait avant SWY-1523 — c'est le « avant » de l'écart.
  const sAbl = summarizeRoutineRuns(b3eb1a69, DISPOSITION_VOCAB_ABLATED);
  const fleetAbl = summarizeFleetRuns([...b3eb1a69, ...cancelledFires], "2026-08-01T00:00:00.000Z",
    DISPOSITION_VOCAB_ABLATED);
  check("ABLATION — sans `blocked` dans la table, le tir LIVRÉ redevient un créneau NON DÉLIVRÉ",
    { last: sAbl.lastScheduledLiveAt, streak: sAbl.failedStreak,
      undelivered: sAbl.undeliveredStreak, byStatus: sAbl.undeliveredByStatus,
      unknown: sAbl.repaint.unknown, aboutisFlotte: fleetAbl.scheduledLiveInWindow },
    { last: "2026-08-14T06:00:15.362Z", streak: 1, undelivered: 1, byStatus: { failed: 1 },
      unknown: 1, aboutisFlotte: 1 });

  // ── 5. LE GARDE DE FLAG, tiré pour de vrai (SWY-1523, point 4) ──────────────────────
  // Un flag mal orthographié lançait le balayage de PRODUCTION avec exit 0. Le garde se teste
  // en sous-processus parce que c'est du code de niveau module — et les deux sens sont tirés :
  // il refuse l'inconnu, et il ne refuse PAS un flag connu (sinon il serait juste cassé).
  // L'environnement du fils est privé de DATABASE_URL/PAPERCLIP_COMPANY_ID : aucun accès base
  // ne peut avoir lieu, même si le garde laissait passer.
  const { spawnSync } = require_("node:child_process");
  const self = new URL(import.meta.url).pathname;
  const spawnSelf = (args) => spawnSync(process.execPath, [self, ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "", PAPERCLIP_COMPANY_ID: "", ROUTINE_DISPOSITION_ABLATE: "" },
  });
  const bad = spawnSelf(["--selftst"]);
  check("POSITIF garde — flag mal orthographié (`--selftst`) : exit 3, RIEN n'est balayé",
    { code: bad.status, refused: /non reconnu/.test(bad.stderr ?? ""),
      scanned: /routine-liveness v2/.test(bad.stdout ?? "") },
    { code: 3, refused: true, scanned: false });
  const good = spawnSelf(["--json", "--window-hours", "168"]);
  check("NÉGATIF garde — flags CONNUS : le garde se taît (l'arrêt vient de l'env, pas de lui)",
    { code: good.status, refused: /non reconnu/.test(good.stderr ?? "") },
    { code: 3, refused: false });

  const pausedManual = { routineStatus: "active", disarmed: false, hasAssignee: true,
    agentStatus: "paused", invokable: false, failedStreak: 0, pauseReason: "manual",
    scheduledPathDead: false, undeliveredStreak: 0 };
  check("POSITIF SWY-1669 — paused/manual + PATH_OK + 0 non délivré : pas terminal",
    assigneeVerdict(pausedManual), "PATH_DELIVERING");
  check("NÉGATIF ADJACENT SWY-1669 — même chemin récent + non délivrés > 0 : terminal maintenu",
    assigneeVerdict({ ...pausedManual, failedStreak: 1, undeliveredStreak: 1 }), "DEAD_TERMINAL");
  check("NÉGATIF IRRÉVERSIBLE SWY-1669 — terminated : terminal quel que soit le chemin",
    assigneeVerdict({ ...pausedManual, agentStatus: "terminated" }), "DEAD_TERMINAL");

  console.log(`\n${failures === 0 ? "TOUS les cas passent" : `${failures} cas ÉCHOUE(NT)`} `
    + `— vocabulaire : delivered={${[...bench.delivered].join(",")}} excluded={${[...bench.excluded].join(",")}}`);
  return failures === 0 ? 0 : 1;
}

// ── Flags : vocabulaire FERMÉ, et un inconnu ARRÊTE le script ──────────────────────────
//
// SWY-1523 — ce fichier n'avait AUCUN garde de flag : `--selftest`, `--self_test`, `--dry-run`
// y lançaient le balayage de PRODUCTION avec exit 0, ce qui se lit « tests verts ». C'est la
// même panne que SWY-1456 a corrigée sur `routine-watchdog.mjs`, à ceci près qu'ici le script
// est CITÉ comme preuve de vivacité : un « tout va bien » pris pour un vert de test est pire
// qu'une erreur. On refuse net (exit 3), sans rien balayer.
const BOOL_FLAGS = new Set(["--json", "--assume-armed", "--refusal-control", "--self-test"]);
const VALUE_FLAGS = new Set(["--window-hours", "--fleet-stale-hours"]);
const unknownFlags = process.argv.slice(2).filter((a) => a.startsWith("--")
  && !BOOL_FLAGS.has(a) && !VALUE_FLAGS.has(a) && !VALUE_FLAGS.has(a.split("=")[0]));
if (unknownFlags.length) {
  console.error(`flag(s) non reconnu(s) : ${unknownFlags.join(", ")} — RIEN n'a été balayé.\n`
    + `  connus : ${[...BOOL_FLAGS].join(" ")} ${[...VALUE_FLAGS].map((f) => `${f} <n>`).join(" ")}\n`
    + `  (le selftest s'écrit \`--self-test\` ; un balayage de PRODUCTION `
    + `ne doit jamais pouvoir se déclencher sur une faute de frappe)`);
  process.exit(3);
}

const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const asJson = process.argv.includes("--json");
// SWY-1121 — POIGNÉE DE TIR À BLANC. Le remède ci-dessous ÉTEINT un rouge ; un garde dont on
// vient d'élargir le silence doit pouvoir prouver qu'il sait encore rendre ROUGE, sans qu'on
// ait à réarmer une routine en prod pour le vérifier. `--assume-armed` fait comme si tous les
// triggers `schedule` étaient armés : c'est le CAS NÉGATIF du remède, rejouable par n'importe
// qui, à tout moment, en lecture seule.
const assumeArmed = process.argv.includes("--assume-armed");
// SWY-1268 — CONTRÔLE POSITIF DU DÉTECTEUR « OCCUPÉ ». Le garde imprime « 0 refus pendant un
// run ACTIF », et ce zéro sert à réfuter la lecture « l'hôte était occupé ». Un zéro produit
// par un détecteur aveugle se lirait exactement pareil. `--refusal-control` sonde le MILIEU
// des derniers runs terminés de chaque assignee — des instants où l'agent était occupé PAR
// CONSTRUCTION — et vérifie que le détecteur répond OUI. S'il répond NON, le zéro ne vaut rien
// et la ligne le dit. Lecture seule, rejouable par n'importe qui.
const refusalControl = process.argv.includes("--refusal-control");
const windowHours = Number(flag("window-hours", 168));
const fleetStaleHours = Number(flag("fleet-stale-hours", 26));

// SWY-1523 — LE SELFTEST PASSE AVANT TOUT ACCÈS BASE, et avant les contrôles d'env : c'est
// ce qui le rend rejouable par n'importe qui, n'importe où, sans DATABASE_URL et sans risque
// de toucher la production. Il est HORS LIGNE par construction (fixtures en mémoire).
if (process.argv.includes("--self-test")) {
  process.exit(selftest());
}

// SWY-1523 — l'ablation du vocabulaire est un outil de TEST. Un balayage de production qui
// l'utiliserait recompterait des tirs ABOUTIS comme des échecs, en silence : c'est la panne
// que cette carte répare. On refuse plutôt que d'offrir l'interrupteur.
if (process.env.ROUTINE_DISPOSITION_ABLATE) {
  console.error("⚠ ROUTINE_DISPOSITION_ABLATE est positionné : l'ablation du vocabulaire de "
    + "disposition (SWY-1523) n'est PAS un mode de production. La rejouer par `--self-test`.");
  process.exit(3);
}

const CID = process.env.PAPERCLIP_COMPANY_ID;
if (!CID) {
  console.error("PAPERCLIP_COMPANY_ID manquant");
  process.exit(3);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant");
  process.exit(3);
}

const sql = loadPostgres()(process.env.DATABASE_URL, { max: 2, ssl: false });
const measuredAt = new Date();
const iso = (d) => (d ? new Date(d).toISOString() : null);
const hoursSince = (d) => (d ? +((measuredAt.getTime() - new Date(d).getTime()) / 3_600_000).toFixed(1) : null);

// SWY-1121 — LE DÉSARMEMENT NE VIT PAS DANS `routines.status`. La v2 ne lisait que
// `r.status`, et manquait donc la seconde des DEUX formes équivalentes d'extinction que
// j'avais moi-même offertes au board sur l'approval `d5496aaa` :
//   (a) `PATCH /api/routines/{id} {"status":"inactive"}`      → lue par `r.status`
//   (b) `PATCH /api/routine-triggers/{id} {"enabled":false}`  → INVISIBLE ici
// Le board a choisi (b) le 2026-08-06 à 06:12:16Z sur `784ed417`, la plus réversible des
// deux. Le garde a continué d'imprimer `DEAD_TERMINAL` + exit 2 pendant 7 h sur une routine
// correctement éteinte — un ROUGE FAUX, qui a fait naître SWY-1116/SWY-1121 en collatéral.
// Une règle énoncée au board doit être tirée contre son propre instrument.
//
// `kind='schedule'` et pas n'importe quel trigger : `deffdff9`, `972c24a1` et `23564734`
// portent AUSSI un trigger `api`, et un trigger `api` armé ne dit RIEN du chemin planifié.
// Compter tous les triggers rendrait le garde juste par accident sur ces trois-là.
const routines = await sql`
  SELECT r.id, r.title, r.status, r.catch_up_policy, r.last_triggered_at,
         a.id AS agent_id, a.name AS agent_name, a.status AS agent_status,
         a.pause_reason, a.paused_at, a.last_heartbeat_at,
         (SELECT count(*)::int FROM public.routine_triggers t
           WHERE t.routine_id = r.id AND t.kind = 'schedule') AS sched_total,
         (SELECT count(*)::int FROM public.routine_triggers t
           WHERE t.routine_id = r.id AND t.kind = 'schedule' AND t.enabled) AS sched_armed
  FROM public.routines r
  LEFT JOIN agents a ON a.id = r.assignee_agent_id
  WHERE r.company_id = ${CID}
  ORDER BY r.title`;

// SWY-1523 — UNE SEULE LECTURE DES RUNS, BRUTE, POUR TOUTE LA COMPANY.
//
// Les quatre agrégats SQL par routine (max/max/count/group by) sont remplacés par ce SELECT
// et par les fonctions pures ci-dessus. Trois raisons, dans cet ordre :
//   1. le vocabulaire des repeintures ne peut vivre qu'à UN endroit, sinon il divergera ;
//   2. ce qui vit dans du SQL ne se rejoue pas hors base, donc ne se teste pas ;
//   3. accessoirement, 1 requête au lieu de 4×N — 365 lignes mesurées le 2026-08-17.
// JAMAIS borné à la fenêtre : une routine morte depuis 36 j n'a aucun run dans 7 j, et une
// borne ferait passer son dernier succès pour `null`, indistinctement d'une routine jamais
// lancée. La fenêtre ne borne QUE les deux colonnes de flotte, qui l'annoncent.
const allRuns = await sql`
  SELECT rr.routine_id, rr.source, rr.status, rr.failure_reason, rr.linked_issue_id,
         rr.triggered_at
  FROM routine_runs rr
  JOIN routines r ON r.id = rr.routine_id
  WHERE r.company_id = ${CID}`;
const runsByRoutine = new Map();
for (const row of allRuns) {
  const k = String(row.routine_id);
  if (!runsByRoutine.has(k)) runsByRoutine.set(k, []);
  runsByRoutine.get(k).push(row);
}

const findings = [];

for (const r of routines) {
  // Dernier tir ABOUTI, par CHEMIN, et compteurs d'échec : voir `summarizeRoutineRuns`.
  // La distinction `schedule` / toutes sources est le cœur de la v2. Les DEUX se comptent sur
  // la MÊME population (mêmes statuts, même absence de borne) — sinon la comparaison est
  // cassée, et c'est la comparaison qui porte le signal.
  const runSummary = summarizeRoutineRuns(runsByRoutine.get(String(r.id)) ?? []);
  const lastScheduledLiveAt = runSummary.lastScheduledLiveAt;
  const lastAnySourceLiveAt = runSummary.lastAnySourceLiveAt;
  const failedStreak = runSummary.failedStreak;

  // ── SWY-1268, correctif 1 : LE COMPTEUR NE VOYAIT QU'UNE DES TROIS NON-LIVRAISONS ────
  // `failedStreak` ci-dessus ne compte que `failed`. Mesuré le 2026-08-12 sur `972c24a1` :
  // 8 créneaux planifiés consécutifs non délivrés depuis le dernier tir vivant
  // (2026-08-08T07:00:29Z), TOUS en `skipped` — et le garde imprimait `streak=0` sur une
  // routine `PATH_STALE` depuis 98,9 h. Un critère de vie fondé sur le streak seul l'aurait
  // déclarée verte. Le compteur juste est « créneaux planifiés consécutifs NON DÉLIVRÉS ».
  //
  // ANCRE : `lastScheduledLiveAt`, PAS `lastAnySourceLiveAt`. C'est le §1 de la v2 appliqué
  // à ce compteur-ci : ancrer sur toutes sources laisserait un tir MANUEL remettre à zéro un
  // compteur qui parle du CHEMIN PLANIFIÉ — la compensation éteignant la mesure de la panne.
  // Le choix est strictement non-silencieux : quand un manuel est plus récent, l'ancre
  // planifiée est ANTÉRIEURE, donc le compte est plus GRAND, jamais plus petit.
  //
  // PORTÉE : `source='schedule'` seule. Un `skipped` manuel n'est pas un créneau manqué.
  //
  // Le détail par statut est CONSERVÉ et imprimé : `failed` accuse l'hôte, `skipped`/
  // `coalesced` accusent une issue d'exécution restée vivante. Deux remèdes opposés — les
  // additionner sans les nommer ferait envoyer le bon chiffre au mauvais destinataire.
  //
  // SWY-1523 — c'est ICI que la repeinture faisait le plus de dégâts : sur `b3eb1a69`, le tir
  // du 2026-08-17T06:00:28Z avait LIVRÉ (carte SWY-1491, prise et disposée en `blocked`) et
  // cette ligne l'imprimait « 1 créneau NON DÉLIVRÉ {failed:1} », `cause=refused`, c'est-à-dire
  // en accusant l'hôte d'un refus qui n'a jamais eu lieu.
  const undeliveredByStatus = runSummary.undeliveredByStatus;
  const undeliveredStreak = runSummary.undeliveredStreak;
  const undeliveredSince = runSummary.undeliveredSince;
  // La cause DOMINANTE nomme le destinataire du remède. `refused` → l'hôte / l'ordonnanceur ;
  // `exec_issue_alive` → une issue d'exécution non terminale qui bloque tous les créneaux.
  const undeliveredCause =
    undeliveredStreak === 0
      ? null
      : (undeliveredByStatus.failed ?? 0) >= (undeliveredByStatus.skipped ?? 0) + (undeliveredByStatus.coalesced ?? 0)
        ? "refused"
        : "exec_issue_alive";

  // ── SWY-1268, correctif 2 : « OCCUPÉ » vs « REFUSÉ », MESURÉ, PAS SUPPOSÉ ────────────
  // La ligne `assignee=X (running) invokable=true` imprimée À CÔTÉ de 26 refus se lit comme
  // un paradoxe, et a produit deux fois la conclusion fausse « l'ordonnanceur refuse un
  // agent OCCUPÉ ». Elle n'en est pas un : le statut de la ligne est lu MAINTENANT, les refus
  // datent d'heures ou de jours, et `running` n'a jamais été refusable (cf. NOT_INVOKABLE_MSG).
  //
  // Plutôt que d'énoncer la règle en commentaire, on la MESURE : pour chaque refus, l'hôte
  // avait-il un run de heartbeat ACTIF à cet instant précis ? Mesuré le 2026-08-12 sur
  // `23564734` : **0 refus sur 26** pendant un run actif de Chris. L'hypothèse « hôte occupé »
  // est donc réfutée sur la totalité des événements, et le garde le dit lui-même.
  //
  // `hbRunsWithStart` est le CONTRÔLE D'INSTRUMENT et sort toujours : si l'assignee n'a aucun
  // run horodaté dans la fenêtre, `0 pendant un run actif` ne mesure rien — c'est un « je ne
  // sais pas », et l'imprimer comme un zéro serait un mensonge d'instrument.
  const [refusalRow] = r.agent_id
    ? await sql`
        SELECT count(*)::int AS n,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM heartbeat_runs h
                 WHERE h.agent_id = ${r.agent_id}
                   AND h.started_at IS NOT NULL
                   AND h.started_at <= rr.triggered_at
                   AND (h.finished_at IS NULL OR h.finished_at >= rr.triggered_at)))::int AS n_busy
        FROM routine_runs rr
        WHERE rr.routine_id = ${r.id} AND rr.source = 'schedule' AND rr.status = 'failed'
          AND rr.failure_reason ILIKE ${"%" + NOT_INVOKABLE_MSG + "%"}
          AND rr.triggered_at > now() - (${windowHours} || ' hours')::interval`
    : [{ n: 0, n_busy: 0 }];
  const [hbRow] = r.agent_id
    ? await sql`
        SELECT count(*)::int AS n FROM heartbeat_runs
        WHERE agent_id = ${r.agent_id} AND started_at IS NOT NULL
          AND started_at > now() - (${windowHours} || ' hours')::interval`
    : [{ n: 0 }];
  const notInvokableRefusals = refusalRow?.n ?? 0;
  const refusalsDuringActiveRun = refusalRow?.n_busy ?? 0;
  const hbRunsWithStart = hbRow?.n ?? 0;

  // Le signal de première classe que la plateforme écrit déjà et que PERSONNE n'escalade.
  // Séparé par `source` : `automation` = tirs de routine, `assignment` = issues qui n'ont
  // pas pu réveiller leur assignee (invisible dans routine_runs, et souvent majoritaire).
  const refusals = await sql`
    SELECT source, count(*)::int AS n, max(created_at) AS last_at
    FROM agent_wakeup_requests
    WHERE company_id = ${CID} AND agent_id = ${r.agent_id}
      AND reason = 'agent.not_invokable'
      AND created_at > now() - (${windowHours} || ' hours')::interval
    GROUP BY source`;
  const notInvokableBySource = Object.fromEntries(refusals.map((x) => [x.source ?? "?", x.n]));
  const notInvokableTotal = refusals.reduce((s, x) => s + x.n, 0);

  const invokable = r.agent_status ? isInvokable(r.agent_status) : false;

  // Le discriminant qui décide s'il faut AGIR, et il ne porte PAS sur `paused_at` :
  //   - une pause du quota guardian se relève TOUTE SEULE (agent_wakeup_requests
  //     reason='quota_guardian_resume') et n'écrit NI pause_reason NI paused_at ;
  //   - une pause `manual` ne se relève JAMAIS seule : le guardian ne reprend que SES pauses,
  //     et `POST /api/agents/:id/resume` est board-only (assertBoard).
  // Confondre les deux, c'est soit escalader pour rien, soit laisser un zombie 35 j.
  // SWY-1121 — DÉSARMÉE, mesuré sur les triggers, pas déduit de `r.status`.
  // Le filtre porte sur ce qui DÉFINIT un désarmement explicite : il EXISTE au moins un
  // trigger `schedule` (sched_total > 0) et AUCUN n'est armé. Une routine active SANS aucun
  // trigger `schedule` n'entre PAS ici — elle n'a jamais été armée, ce qui est un autre
  // défaut, et le taire serait réparer plus large que la panne.
  const schedArmed = assumeArmed ? Math.max(1, r.sched_total) : r.sched_armed;
  const disarmed = r.status === "active" && r.sched_total > 0 && schedArmed === 0;

  // Sous-verdict INDÉPENDANT du précédent, et c'est le point 1 de la v2 : une routine peut
  // être `LIVE`/`LIVE_AFTER_THAW` (assignee invocable, streak nul) et n'avoir tout de même
  // AUCUN tir planifié abouti depuis des jours. Le premier verdict juge l'ASSIGNEE, celui-ci
  // juge le CHEMIN. Ne jamais fusionner les deux : c'est ce qui a rendu le garde muet.
  const scheduledPathStaleHours = hoursSince(lastScheduledLiveAt);
  // SWY-1121 — `!disarmed` s'ajoute ici pour la même raison qu'au verdict, et SEULEMENT ici :
  // ce booléen affirme « l'ordonnanceur DEVRAIT livrer et ne livre pas ». Sur une routine
  // désarmée il n'y a plus de chemin planifié à tenir : l'avertissement n'aurait plus de
  // destinataire capable d'agir. La colonne `pathVerdict` ci-dessous, elle, reste INTACTE et
  // continuera d'imprimer `PATH_STALE` — elle ne dit que ce qu'elle a mesuré (871 h sans tir
  // planifié abouti, ce qui est vrai), et c'est la trace qui empêche le désarmement de
  // devenir invisible.
  const scheduledPathDead =
    r.status === "active" &&
    !disarmed &&
    (lastScheduledLiveAt === null || scheduledPathStaleHours > fleetStaleHours);

  const verdict = assigneeVerdict({
    routineStatus: r.status, disarmed, hasAssignee: Boolean(r.agent_id),
    agentStatus: r.agent_status, invokable, failedStreak, pauseReason: r.pause_reason,
    scheduledPathDead, undeliveredStreak,
  });

  // SWY-1085 — LA COLONNE QU'ON RECOPIE DOIT PORTER LE SOUS-VERDICT. Le sous-verdict
  // ci-dessus existait déjà, mais il n'était visible que DEUX LIGNES PLUS BAS, tandis que la
  // ligne qu'on cite est celle du `verdict`. Mesuré : `deffdff9` imprimait `LIVE` avec
  // planifié=JAMAIS, et cette ligne exacte a servi de prémisse à « le tick est déjà porté
  // ailleurs et vivant » — réfutée en cinq allers-retours entre deux agents dans la nuit du
  // 05 au 06/08, et re-tirée une seconde fois par le relecteur. Deux lecteurs corrects, la
  // même conclusion fausse : c'est un défaut d'AFFICHAGE.
  //
  // Le remède est une SECONDE colonne, pas un enrichissement de la première. Un fork v1 avait
  // tenté de remplacer le verdict d'assignee par un `UNPROVEN_NEVER_SUCCEEDED` dans la même
  // chaîne `else if` : c'est précisément la fusion interdite ci-dessus, celle qui a rendu le
  // garde muet. Les six valeurs de `verdict` sont donc inchangées, et celle-ci est disjointe.
  //
  // Elle juge le CHEMIN SEUL, sans la garde `r.status === 'active'` de `scheduledPathDead` :
  // sur une routine inactive, retomber en `PATH_OK` affirmerait que le chemin livre alors
  // qu'on n'en sait rien. `ROUTINE_INACTIVE` dit déjà l'état de la routine ; cette colonne ne
  // doit dire que ce qu'elle a mesuré. Aucune requête SQL nouvelle : deux champs déjà calculés.
  const pathVerdict =
    lastScheduledLiveAt === null
      ? "PATH_NEVER"
      : scheduledPathStaleHours > fleetStaleHours
        ? "PATH_STALE"
        : "PATH_OK";

  findings.push({
    routineId: r.id,
    title: r.title,
    routineStatus: r.status,
    // SWY-1121 — publiés À CÔTÉ de `routineStatus`, jamais à sa place : `status` et
    // l'armement des triggers sont DEUX mesures, et c'est de les avoir confondues que
    // venait le rouge faux.
    schedTriggersTotal: r.sched_total,
    schedTriggersArmed: r.sched_armed,
    disarmed,
    catchUpPolicy: r.catch_up_policy,
    agent: r.agent_name,
    agentStatus: r.agent_status,
    invokable,
    pauseReason: r.pause_reason,
    pausedAt: iso(r.paused_at),
    // Conservé pour lecture humaine, JAMAIS utilisé comme discriminant — voir l'en-tête et
    // le §4 de SWY-997 : le champ n'est écrit que sur 4 chemins, dont aucun n'est
    // « l'ordonnanceur a atteint l'agent ». Il gèle pendant tout un run et n'est pas écrit
    // du tout quand le run finalise sur un agent `paused`.
    lastHeartbeatAt: iso(r.last_heartbeat_at),
    lastTriggeredAt: iso(r.last_triggered_at),
    lastScheduledLiveAt: iso(lastScheduledLiveAt),
    lastAnySourceLiveAt: iso(lastAnySourceLiveAt),
    scheduledPathStaleHours,
    scheduledPathDead,
    // Conservé À CÔTÉ de `scheduledPathDead`, pas à sa place : un consommateur éventuel du
    // booléen ne doit pas avoir à être réécrit pour que la colonne humaine existe.
    pathVerdict,
    // SWY-1268 — `failedStreak` est CONSERVÉ à côté du compteur juste, jamais remplacé :
    // c'est l'ablation intégrée. Sur `972c24a1` la paire imprime `0` et `8` sur la même
    // ligne — le lecteur voit d'un coup d'œil ce que l'ancien critère ne voyait pas, et
    // aucune relecture d'historique n'est nécessaire pour le croire.
    failedStreak,
    undeliveredStreak,
    undeliveredByStatus,
    undeliveredSince: iso(undeliveredSince),
    undeliveredCause,
    notInvokableRefusals,
    refusalsDuringActiveRun,
    hbRunsWithStart,
    firstFailAt: iso(runSummary.firstFailAt),
    // SWY-1523 — les lignes REPEINTES de cette routine, sorties telles quelles : combien de
    // tirs comptés ABOUTIS parce qu'un agent a disposé leur carte, combien EXCLUS des deux
    // populations, et combien d'états HORS TABLE. Trois zéros et un état inconnu ne se lisent
    // pas pareil ; les taire ferait de la correction un chiffre qu'on ne peut plus auditer.
    repaint: runSummary.repaint,
    notInvokableWakeups: notInvokableTotal,
    notInvokableBySource,
    verdict,
    selfHealing: verdict === "DEAD_SELF_HEALING",
  });
}

// ── Règle de portée COMPANY ─────────────────────────────────────────────────────────
// Aucune règle par routine ne répond à « le chemin planifié livre-t-il encore ? ». Tant que
// cette question n'a pas de réponse imprimée, l'absence de finding est indiscernable d'une
// company en bonne santé — et c'est exactement ce qui s'est produit pendant 5,4 jours.
//
// SWY-1523 — comptés sur les MÊMES lignes brutes que les compteurs par routine, avec le MÊME
// classement. La borne de fenêtre vient de l'horloge de la BASE (`db_now` ci-dessous) et non
// de celle de ce processus : les quatre agrégats remplacés utilisaient `now()` côté serveur,
// et changer de référentiel d'horloge en même temps que de vocabulaire aurait rendu l'écart
// avant/après inattribuable.
const [{ db_now: dbNow }] = await sql`SELECT now() AS db_now`;
const fleetCutoffIso = new Date(new Date(dbNow).getTime() - windowHours * 3_600_000).toISOString();
const fleetRuns = summarizeFleetRuns(allRuns, fleetCutoffIso);

// Refus d'invocation de la flotte entière, tous agents — le détecteur sans aucune
// dépendance de routine. C'est le §3 de SWY-997.
const fleetRefusals = await sql`
  SELECT w.agent_id, a.name, a.status, a.pause_reason, w.source,
         count(*)::int AS n, min(w.created_at) AS first_at, max(w.created_at) AS last_at
  FROM agent_wakeup_requests w
  LEFT JOIN agents a ON a.id = w.agent_id
  WHERE w.company_id = ${CID} AND w.reason = 'agent.not_invokable'
    AND w.created_at > now() - (${windowHours} || ' hours')::interval
  GROUP BY w.agent_id, a.name, a.status, a.pause_reason, w.source
  ORDER BY n DESC`;

const fleet = {
  lastScheduledLiveAt: iso(fleetRuns.lastScheduledLiveAt),
  lastAnySourceLiveAt: iso(fleetRuns.lastAnySourceLiveAt),
  scheduledStaleHours: hoursSince(fleetRuns.lastScheduledLiveAt),
  // TENTÉS et VIVANTS sur la MÊME population (source=schedule, même fenêtre). Leur écart
  // EST le signal : « 65 tentés / 0 vivant » ne se déduit pas d'une seule des deux lignes.
  scheduledAttemptedInWindow: fleetRuns.scheduledAttemptedInWindow,
  scheduledLiveInWindow: fleetRuns.scheduledLiveInWindow,
  // SWY-1523 — les lignes EXCLUES des DEUX colonnes ci-dessus, comptées et imprimées. Une
  // exclusion muette transformerait la correction en chiffre inauditable : le lecteur verrait
  // les TENTÉS baisser sans savoir pourquoi.
  scheduledExcludedInWindow: fleetRuns.scheduledExcludedInWindow,
  repaintInWindow: fleetRuns.repaintInWindow,
  repaintAll: fleetRuns.repaintAll,
  windowCutoffAt: fleetCutoffIso,
  noLiveScheduledFire:
    !fleetRuns.lastScheduledLiveAt || hoursSince(fleetRuns.lastScheduledLiveAt) > fleetStaleHours,
  refusalsTotal: fleetRefusals.reduce((s, x) => s + x.n, 0),
  refusals: fleetRefusals.map((x) => ({
    agent: x.name,
    agentStatus: x.status,
    pauseReason: x.pause_reason,
    source: x.source,
    count: x.n,
    firstAt: iso(x.first_at),
    lastAt: iso(x.last_at),
  })),
};

// SWY-1268 — le contrôle positif tourne AVANT la fermeture de la connexion, et sa sortie est
// imprimée en tête : un lecteur qui ne verrait que le `0/26` sans le contrôle tirerait du
// détecteur plus que ce qu'il prouve.
const control = [];
if (refusalControl) {
  const agentIds = [...new Set(findings.map((f) => f.routineId && f.agent).filter(Boolean))];
  const rows = await sql`
    SELECT a.id, a.name FROM agents a WHERE a.company_id = ${CID} AND a.name IN ${sql(agentIds.length ? agentIds : [""])}`;
  for (const a of rows) {
    const runs = await sql`
      SELECT started_at, finished_at FROM heartbeat_runs
      WHERE agent_id = ${a.id} AND started_at IS NOT NULL AND finished_at IS NOT NULL
        AND started_at > now() - (${windowHours} || ' hours')::interval
      ORDER BY started_at DESC LIMIT 5`;
    let hit = 0;
    for (const run of runs) {
      const mid = new Date((new Date(run.started_at).getTime() + new Date(run.finished_at).getTime()) / 2);
      const [x] = await sql`
        SELECT count(*)::int AS n FROM heartbeat_runs
        WHERE agent_id = ${a.id} AND started_at IS NOT NULL AND started_at <= ${mid}
          AND (finished_at IS NULL OR finished_at >= ${mid})`;
      if ((x?.n ?? 0) > 0) hit += 1;
    }
    control.push({ agent: a.name, probed: runs.length, detectedBusy: hit, ok: runs.length > 0 && hit === runs.length });
  }
}

await sql.end();

if (refusalControl && !asJson) {
  console.log("── contrôle positif du détecteur « occupé » (SWY-1268) ──");
  for (const c of control) {
    console.log(
      `  ${String(c.agent).padEnd(11)} ${c.detectedBusy}/${c.probed} instants PENDANT un run terminé détectés OCCUPÉ` +
        `${c.probed === 0 ? "  ⚠ aucun run terminé à sonder — le détecteur n'est PAS validé sur cet agent" : c.ok ? "  ✔" : "  ⚠ DÉTECTEUR EN DÉFAUT — le « 0 refus pendant un run » ci-dessous ne prouve rien"}`,
    );
  }
  console.log("");
}

if (asJson) {
  console.log(JSON.stringify({ measuredAt: iso(measuredAt), windowHours, fleetStaleHours, fleet, findings }, null, 2));
} else {
  console.log(`routine-liveness v2 — ${findings.length} routine(s), fenêtre ${windowHours} h, mesuré ${iso(measuredAt)}\n`);
  // Deux colonnes de JUGEMENT sur la ligne d'en-tête de chaque routine, jamais fusionnées :
  // `verdict` juge l'ASSIGNEE, `chemin` juge le CHEMIN PLANIFIÉ. Une ligne recopiée hors de
  // cette sortie porte désormais les deux. L'en-tête est en minuscules à dessein : les
  // lectures automatiques ancrées sur `^[A-Z_]+` ne l'attrapent pas.
  const INDENT = " ".repeat(31); // 18 (verdict) + 1 + 11 (chemin) + 1 → aligne sous l'id
  console.log(`${"verdict".padEnd(18)} ${"chemin".padEnd(11)} id        titre`);
  for (const f of findings) {
    console.log(`${f.verdict.padEnd(18)} ${f.pathVerdict.padEnd(11)} ${f.routineId.slice(0, 8)}  ${(f.title ?? "").slice(0, 46)}`);
    // SWY-1268 — « lu MAINTENANT » est dans la ligne elle-même, pas dans un commentaire de
    // source. La ligne se recopie ; l'en-tête du fichier, non. C'est la leçon de SWY-1085,
    // appliquée cette fois à la colonne `invokable` : le statut est un instantané POSTÉRIEUR
    // aux refus imprimés deux lignes plus bas, et rien ne le disait.
    console.log(
      `${INDENT}assignee=${f.agent} (${f.agentStatus}${f.pauseReason ? "/" + f.pauseReason : ""}` +
        `, lu MAINTENANT) invokable=${f.invokable}`,
    );
    if (f.disarmed) {
      console.log(
        `${INDENT}✔ DÉSARMÉE — ${f.schedTriggersArmed}/${f.schedTriggersTotal} trigger(s) schedule armé(s) ; ` +
          `extinction par trigger, routine laissée status=${f.routineStatus} (réversible)`,
      );
    }
    console.log(`${INDENT}streak=${f.failedStreak}  refus not_invokable=${f.notInvokableWakeups} ${JSON.stringify(f.notInvokableBySource)}`);
    // Le compteur juste, imprimé À CÔTÉ de l'ancien (`streak=` ci-dessus) : leur écart EST le
    // signal, exactement comme TENTÉS/ABOUTIS pour la flotte.
    console.log(
      `${INDENT}créneaux planifiés NON DÉLIVRÉS depuis le dernier tir PLANIFIÉ abouti = ${f.undeliveredStreak}` +
        ` ${JSON.stringify(f.undeliveredByStatus)}` +
        `${f.undeliveredSince ? ` depuis ${f.undeliveredSince}` : ""}`,
    );
    if (f.undeliveredCause === "exec_issue_alive") {
      console.log(
        `${INDENT}  ↳ cause dominante : une issue d'exécution VIVANTE bloque les créneaux ` +
          `(concurrencyPolicy=skip_if_active). L'hôte n'est PAS en cause — le remède est de ` +
          `clore l'issue d'exécution restée ouverte, pas de dégeler un agent.`,
      );
    }
    // SWY-1523 — la ligne des REPEINTURES, imprimée dès qu'il y en a une. Les deux compteurs
    // au-dessus se lisent faux sans elle : « streak=0 » sur une routine dont le dernier tir
    // s'affiche `failed` dans l'interface a l'air d'un bug du garde, alors que c'est la
    // normalisation qui travaille. Un état HORS TABLE se dit en CRI, jamais en note de bas.
    if (f.repaint.delivered || f.repaint.excluded || f.repaint.unknown || f.repaint.malformed) {
      console.log(
        `${INDENT}lignes REPEINTES par une disposition postérieure : ` +
          `${f.repaint.delivered} ABOUTIE(S) ${JSON.stringify(f.repaint.byState.delivered)}, ` +
          `${f.repaint.excluded} EXCLUE(S) des deux populations ${JSON.stringify(f.repaint.byState.excluded)}`,
      );
      if (f.repaint.unknown || f.repaint.malformed) {
        console.log(
          `${INDENT}  ⚠ ${f.repaint.unknown} état(s) de disposition HORS TABLE ` +
            `${JSON.stringify(f.repaint.byState.unknown)} et ` +
            `${f.repaint.malformed} motif(s) « moved to » de forme inconnue : comptés ÉCHECS par défaut. ` +
            `À classer dans routine-run-disposition.mjs (delivered={${DISPOSITION_DELIVERED_STATES.join(",")}}, ` +
            `excluded={${DISPOSITION_EXCLUDED_STATES.join(",")}}) — jusque-là, les deux compteurs ci-dessus ` +
            `sur-comptent les non-livraisons.`,
        );
      }
    }
    if (f.notInvokableRefusals > 0) {
      // Le contrôle d'instrument passe AVANT le chiffre qu'il conditionne : un `0/N` sorti
      // d'un instrument aveugle se lit comme une preuve alors qu'il ne mesure rien.
      const blind = f.hbRunsWithStart === 0;
      console.log(
        `${INDENT}refus « not invokable » sur la fenêtre = ${f.notInvokableRefusals}, ` +
          `dont pendant un run ACTIF de l'assignee = ${blind ? "NON MESURABLE" : f.refusalsDuringActiveRun}` +
          ` (${f.hbRunsWithStart} run(s) horodaté(s) de l'assignee dans la fenêtre)`,
      );
      if (!blind && f.refusalsDuringActiveRun === 0) {
        console.log(
          `${INDENT}  ↳ « hôte OCCUPÉ » est RÉFUTÉ sur la totalité de ces refus : le message ` +
            `n'est émis que si le statut PROPRE valait paused|terminated|pending_approval|inconnu ` +
            `(agent-invokability.ts:94) ; running et idle sont invocables.`,
        );
      }
    }
    console.log(
      `${INDENT}dernier tir ABOUTI — planifié=${f.lastScheduledLiveAt ?? "JAMAIS"}` +
        `${f.scheduledPathStaleHours !== null ? ` (${f.scheduledPathStaleHours} h)` : ""}` +
        ` | toutes sources=${f.lastAnySourceLiveAt ?? "JAMAIS"}`,
    );
    if (f.scheduledPathDead) {
      console.log(`${INDENT}⚠ CHEMIN PLANIFIÉ MORT (> ${fleetStaleHours} h) — un tir manuel récent ne l'acquitte PAS`);
    }
  }
  console.log(`\n── flotte ──`);
  console.log(`  tirs planifiés sur ${windowHours} h : ${fleet.scheduledAttemptedInWindow} TENTÉS / ${fleet.scheduledLiveInWindow} ABOUTIS`);
  // SWY-1523 — SOUS les deux colonnes qu'elle corrige, et à CHAQUE passage, y compris à zéro :
  // « aucune ligne repeinte dans la fenêtre » et « je ne sais pas les lire » doivent se lire
  // différemment. Sans cette ligne, la correction serait un chiffre que personne ne peut
  // auditer — et c'est cette paire de colonnes que le manager cite dans ses rapports.
  console.log(`    dont lignes REPEINTES (disposition postérieure au tir) : `
    + `${fleet.repaintInWindow.delivered} ABOUTIE(S) ${JSON.stringify(fleet.repaintInWindow.byState.delivered)} `
    + `comptée(s) dans les DEUX colonnes ; `
    + `${fleet.scheduledExcludedInWindow} EXCLUE(S) ${JSON.stringify(fleet.repaintInWindow.byState.excluded)} `
    + `retirée(s) des DEUX colonnes`);
  if (fleet.repaintInWindow.unknown || fleet.repaintInWindow.malformed) {
    console.log(`    ⚠ ${fleet.repaintInWindow.unknown} état(s) HORS TABLE `
      + `${JSON.stringify(fleet.repaintInWindow.byState.unknown)} et `
      + `${fleet.repaintInWindow.malformed} motif(s) « moved to » de forme inconnue dans la fenêtre : `
      + `comptés ÉCHECS, donc les TENTÉS/ABOUTIS ci-dessus sur-comptent les non-livraisons. `
      + `Classer l'état dans routine-run-disposition.mjs.`);
  }
  console.log(`  dernier tir planifié abouti : ${fleet.lastScheduledLiveAt ?? "JAMAIS"} (${fleet.scheduledStaleHours ?? "-"} h)`);
  console.log(`  dernier tir abouti toutes sources : ${fleet.lastAnySourceLiveAt ?? "JAMAIS"}   ← ne prouve RIEN sur l'ordonnanceur`);
  if (fleet.noLiveScheduledFire) {
    console.log(`  ⚠ FLEET_NO_LIVE_SCHEDULED_FIRE — aucun tir planifié abouti depuis > ${fleetStaleHours} h`);
  }
  console.log(`  refus d'invocation (agent.not_invokable) : ${fleet.refusalsTotal} sur ${windowHours} h`);
  for (const x of fleet.refusals) {
    console.log(`    ${String(x.agent).padEnd(11)} ${String(x.agentStatus).padEnd(9)} ${String(x.source).padEnd(11)} ${String(x.count).padStart(4)}  ${x.firstAt} → ${x.lastAt}`);
  }
}

const terminal = findings.some((f) => f.verdict === "DEAD_TERMINAL");
const healing = findings.some((f) => f.verdict === "DEAD_SELF_HEALING");
process.exit(terminal || fleet.noLiveScheduledFire ? 2 : healing ? 1 : 0);
