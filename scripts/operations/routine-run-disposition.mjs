// routine-run-disposition.mjs — SWY-1523 : LE VOCABULAIRE DES TIRS REPEINTS, EN UN SEUL ENDROIT
//
// ── CE QUE CE FICHIER EXISTE POUR EMPÊCHER ───────────────────────────────────────────
//
// La plateforme REPEINT la ligne d'un tir de routine quand la carte d'exécution qu'il a
// créée change d'état après coup. `services/routines.ts:2742-2767` (`syncRunStatusForIssue`,
// relu le 2026-08-17) :
//
//     if (issue.status === "done")                          -> finalizeRun(status "completed")
//     if (issue.status === "blocked" || "cancelled")         -> finalizeRun({
//         status: "failed", failureReason: `Execution issue moved to ${issue.status}` })
//
// Le libellé est donc INTERPOLÉ depuis `issues.status`, dont le vocabulaire complet compte
// SEPT valeurs (`packages/shared/src/constants.ts:179` — backlog, todo, in_progress,
// in_review, done, blocked, cancelled). Aujourd'hui la garde n'en laisse passer que DEUX ;
// élargir ce `if` d'une ligne suffirait à faire naître un troisième libellé.
//
// C'est exactement comme ça que le défaut de SWY-1523 est arrivé : `routine-watchdog.mjs`
// énumérait `cancelled|canceled` en dur, `blocked` est apparu le 2026-08-17T06:00:28.534Z,
// et un tir qui avait LIVRÉ (carte SWY-1491, prise par un agent et disposée en `blocked`)
// s'est compté comme un ÉCHEC dans les deux gardes. On ne corrige donc pas en ajoutant
// `|blocked` : on reconnaît la FORME, on classe l'ÉTAT, et **on crie sur un état inconnu**.
// Un garde qui avale tout ce qui ressemble à une disposition est un garde qui ne prévient
// plus — c'est la moitié du remède, pas un détail.
//
// ── LA TABLE SÉMANTIQUE (arrêtée par le manager sur SWY-1523) ────────────────────────
//
//   libellé                 ce qui s'est passé                       comptage
//   ----------------------- ---------------------------------------- ---------------------
//   moved to blocked        la carte EXISTE, un agent l'a prise et   tir ABOUTI (la carte
//                           lui a donné une disposition légitime     PROUVE la livraison),
//                                                                    et elle RESTE dans la
//                                                                    population de drainage
//   moved to cancelled      la carte a été annulée : plus rien à     EXCLU des populations
//                           défendre, ni preuve de drainage ni       (ni abouti ni échoué)
//                           carte à surveiller
//   moved to <inconnu>      on ne sait pas                           reste un ÉCHEC, et le
//                                                                    garde CRIE
//
// Le statut à considérer pour un libellé connu est celui du tir AVANT la repeinture
// (`issue_created`), jamais celui que la disposition postérieure a écrit dessus.
//
// ── POURQUOI UN FICHIER À PART, ET PAS DEUX COPIES ──────────────────────────────────
//
// `routine-watchdog.mjs` (API) et `routine-liveness.mjs` (SQL) lisent deux surfaces
// différentes de la MÊME donnée. Deux copies du vocabulaire divergeraient au premier libellé
// suivant — et c'est précisément le mode de panne qu'on répare : le watchdog connaissait
// `cancelled`, `routine-liveness.mjs` ne connaissait RIEN (`grep -inE "moved to|disposal|
// disposition"` rendait 0 ligne sur 613, mesuré le 2026-08-17). Le vocabulaire vit donc ici,
// une seule fois, et les deux gardes l'importent. Le corollaire est assumé : ce fichier est
// dans le chemin critique des deux, donc il reste minuscule, sans I/O et sans état.
//
// ── LES DEUX DISCRIMINANTS, ET POURQUOI ILS SONT DEUX ───────────────────────────────
//
//   (1) STRUCTUREL — le tir porte une CARTE (`linkedIssueId`). Un refus de dispatch réel n'en
//       a JAMAIS : mesuré le 2026-08-17 sur les 365 runs des 8 routines de la company, les
//       290 lignes « Agent is not invokable in its current state » ont toutes
//       `linked_issue_id IS NULL`, et les 5 lignes repeintes portent toutes une carte.
//   (2) TEXTUEL — la FORME du libellé, ancrée aux deux bouts. Le terme (1) seul blanchirait
//       n'importe quel vrai échec d'exécution porteur de carte ; le terme (2) seul
//       blanchirait un libellé qui ne vient pas du générateur.
//
// L'ancrage est délibéré : « Execution issue moved to blocked by X » ne matche PAS, donc ne
// se fait PAS avaler — il retombe en échec, et côté watchdog R0 crie (tir `failed` porteur
// d'une carte au motif non reconnu). Se tromper dans ce sens-là coûte une alerte de trop ;
// se tromper dans l'autre coûte un silence, qui est ce que cette carte répare.

/**
 * La FORME servie par `syncRunStatusForIssue`, avec l'état capturé.
 * Ancrée aux deux bouts (voir ci-dessus). Le `\.?` final tolère une ponctuation que le
 * générateur n'écrit pas aujourd'hui — coût nul, et un libellé re-ponctué ne doit pas
 * basculer un tir abouti en échec.
 */
export const DISPOSITION_FORM_RE =
  /^\s*execution issue moved to\s+([a-z][a-z0-9_-]*)\s*\.?\s*$/i;

/**
 * Repère LARGE, volontairement plus permissif que la forme : sert uniquement à dire
 * « ça ressemblait à une disposition et je ne l'ai pas reconnue » au lieu de se taire.
 * N'entre JAMAIS dans un classement — seulement dans un cri.
 */
export const DISPOSITION_FORMISH_RE = /moved to/i;

// ÉTATS CLASSÉS. Volontairement les DEUX SEULS que le générateur peut produire aujourd'hui,
// et pas les sept de `ISSUE_STATUSES` : pré-classer `in_progress` ou `todo` « au cas où »
// reviendrait à décider à la place du manager le jour où le serveur changera, et à le
// décider EN SILENCE. Tout le reste est `unknown` et fait crier le garde.
export const DISPOSITION_DELIVERED_STATES = ["blocked"];
// `canceled` (un seul L) est INATTEIGNABLE depuis le générateur actuel (l'interpolation vient
// de `ISSUE_STATUSES`, qui n'a que `cancelled`). Conservé tel quel : il était déjà dans le
// prédicat du watchdog, et le retirer serait un changement de comportement que la table
// sémantique de SWY-1523 ne demande pas.
export const DISPOSITION_EXCLUDED_STATES = ["cancelled", "canceled"];

/** Le vocabulaire de PRODUCTION. */
export const DISPOSITION_VOCAB = Object.freeze({
  delivered: new Set(DISPOSITION_DELIVERED_STATES),
  excluded: new Set(DISPOSITION_EXCLUDED_STATES),
  label: "production",
});

/**
 * ABLATION — le vocabulaire d'AVANT SWY-1523, à un état près : `blocked` n'y est pas.
 *
 * C'est le contrôle exigé au point 4 de la carte, et il est SURGICAL : il ne coupe pas toute
 * la normalisation (ce qui rougirait aussi les cas de `cancelled` et ne prouverait rien sur
 * CE correctif), il retire exactement l'état que ce correctif ajoute. Injecté par les
 * `--self-test` des deux gardes ; refusé en production (voir chaque `main`).
 */
export const DISPOSITION_VOCAB_ABLATED = Object.freeze({
  delivered: new Set(),
  excluded: new Set(DISPOSITION_EXCLUDED_STATES),
  label: "ablated:pre-SWY-1523",
});

/** L'état d'une disposition, en minuscules — ou `null` si la FORME n'est pas là. */
export function parseDispositionState(failureReason) {
  const m = DISPOSITION_FORM_RE.exec(String(failureReason ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/** `true` si le motif RESSEMBLE à une disposition sans en avoir la forme reconnue. */
export function looksLikeDisposition(failureReason) {
  const s = String(failureReason ?? "");
  return DISPOSITION_FORMISH_RE.test(s) && parseDispositionState(s) === null;
}

/**
 * Classe un run. Accepte les deux formes de la même donnée — la projection d'API
 * (`failureReason`, `linkedIssueId`, `linkedIssue`) et la ligne SQL (`failure_reason`,
 * `linked_issue_id`) — parce que les deux gardes lisent deux surfaces et qu'un classement
 * qui ne connaît qu'une des deux se serait tu sur l'autre.
 *
 * @returns {{klass: "none"|"delivered"|"excluded"|"unknown", state: string|null,
 *            hasCard: boolean, formish: boolean}}
 *   - `delivered` : tir ABOUTI repeint en échec — compte comme `issue_created`.
 *   - `excluded`  : hors populations, ni abouti ni échoué.
 *   - `unknown`   : la forme est là, l'état n'est pas classé -> reste un ÉCHEC, et ça CRIE.
 *   - `none`      : ce n'est pas une repeinture (statut ≠ failed, ou pas de carte, ou motif
 *                   hors forme). `formish` distingue alors « motif ordinaire » de
 *                   « ça parlait de `moved to` et je n'ai pas su lire » — le second CRIE aussi.
 */
export function classifyRunDisposition(run, vocab = DISPOSITION_VOCAB) {
  const status = String(run?.status ?? "");
  const hasCard = Boolean(
    run?.linkedIssueId ?? run?.linked_issue_id ?? run?.linkedIssue?.id ?? null,
  );
  const reason = run?.failureReason ?? run?.failure_reason ?? null;
  const state = parseDispositionState(reason);
  const formish = looksLikeDisposition(reason);

  // Les DEUX discriminants sont exigés ensemble (voir l'en-tête). Un `failed` porteur de
  // carte au motif hors forme est un vrai échec d'exécution : il reste un échec.
  if (status !== "failed" || !hasCard || state === null) {
    return { klass: "none", state: null, hasCard, formish };
  }
  if (vocab.delivered.has(state)) return { klass: "delivered", state, hasCard, formish: false };
  if (vocab.excluded.has(state)) return { klass: "excluded", state, hasCard, formish: false };
  return { klass: "unknown", state, hasCard, formish: false };
}

// Ce fichier est une BIBLIOTHÈQUE : ses tests vivent dans le `--self-test` des DEUX gardes
// qui l'importent, chacun par son propre chemin (API pour le watchdog, SQL pour la
// liveness) — un vocabulaire partagé testé une seule fois, hors de ses consommateurs, ne
// prouve pas que les consommateurs l'appliquent. Invoqué directement, on le dit au lieu de
// sortir 0 en silence, qui se lirait « tests passés ».
const invokedDirectly = process.argv[1]
  && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  console.error(
    "routine-run-disposition.mjs est une bibliothèque, pas un exécutable.\n"
    + "  Ses contrôles se rejouent par :\n"
    + "    node /paperclip/bin/routine-watchdog.mjs --self-test\n"
    + "    node /paperclip/bin/routine-liveness.mjs --self-test\n"
    + `  Vocabulaire courant : delivered={${DISPOSITION_DELIVERED_STATES.join(",")}} `
    + `excluded={${DISPOSITION_EXCLUDED_STATES.join(",")}}`,
  );
  process.exit(3);
}
