# NEI context — for anyone building tooling around CLICR

Written for a Claude session (or a new engineer) that needs to understand the NEI
side of this system well enough to help design a dev/staging/prod code-tracking app.
Everything below is taken from the code and from observed production runs, not from
documentation. Where something is uncertain it says so.

---

## 1. Orientation in one paragraph

Nokia InstantLink (`ilink`) provisions telecom network elements. It does not talk to
elements directly — it delegates to a **NEI (Network Element Interface)**: a deployable
package that plugs into InstantLink's **Java Macro Server** and knows how to drive one
family of network elements. This repo is one such NEI, `JAVA_CLICR_ANY_V1`. Its job is
to take a **CIQ** (a change request expressed as JSON) and execute it against network
elements — CFX, SBC, DPA, MRF and others — over SSH/CLI, then prove the change landed
and roll it back if it did not.

The important structural fact for a tracking app: **this NEI is not one artifact.** It
is compiled Java plus interpreted Python plus declarative YAML plus plain-text config,
all shipped in one package but with completely different change cadences and failure
modes. Most of the operational pain in this project comes from those pieces drifting
out of step with each other.

---

## 2. What "NEI" means concretely here

### It is a package that registers with the Macro Server

| Piece | File | Role |
|---|---|---|
| Registration | `src/main/resources/config/mds.rc.add` | appended into the server's `.mds.rc`; declares `program:macro_CLICR_ANY_V1`, template paths, and connection settings |
| Entry point | `target/bin/java_clicr_any_v1.ksh` | sets `JAVA_HOME`, builds the classpath, execs `com.comptel.mds.sas.java_macroserver.MacroServer` |
| Install manifest | `target/bin/.packinglist` | declares every file that ships and where it lands |
| Install hook | `target/bin/configure` | rewrites `__BASEDIR__` placeholders after install |
| GRC section | `Constants.GRC_SECTION = "macro_CLICR_ANY_V1"` | the key the macro server routes on |

The Macro Server is external (`java_macroserver` 9.1.1, JDK8). **This NEI is a plugin, not
an application** — it has no `main()` of its own; the server loads it by classpath and
routes work to it by GRC section name.

### Java version is pinned and low

Java 8. And the Python that ships alongside runs under **Python 2** on the server. Both
constraints are load-bearing: modern syntax in either language fails at runtime, not at
build time. A real production failure in this project was `str()` on a non-ASCII string
in a Python file — invisible on a dev machine running Python 3, fatal on the server.

---

## 3. The deployable unit — what actually ships

From `.packinglist`, the package installs into `$basedir/sas/bin/macro_server/java/`:

```
java/
├── java_clicr_any_v1.ksh                 entry point (placeholders rewritten at install)
├── supp_codes.txt  phase_codes.txt  error_codes.txt
└── CLICR/ANY/V1/
    ├── macro_CLICR_ANY_V1.jar            the compiled Java
    ├── lib/*                             all dependencies, copied flat
    ├── script/
    │   ├── common_functions.ksh  il_nemo_functions.ksh
    │   ├── nemo_setup.ksh  drop_nemo.ksh  nemo_info.txt
    │   ├── nemo_parameters.properties
    │   ├── oracle/drop_nemo.sql   postgres/drop_nemo.sql
    │   └── python/*.py                   ← the comparison / generation scripts
    └── templates/
        ├── yaml/*.yaml                   ← the workflow definitions
        ├── html/*.html                   report + MOP templates
        ├── jsonTemplate/*                output shaping
        └── email/*.txt
```

**Four independently-changing layers in one package:**

| Layer | Changes | Fails when | Detected |
|---|---|---|---|
| Java (`.jar`) | rarely | stale `.class` vs source | at runtime, obscurely |
| Python (`script/python/*.py`) | often | py2 syntax/semantics; deployed copy stale | at runtime |
| YAML (`templates/yaml/*.yaml`) | very often | unknown key → strict bean binding throws | at parse, loudly |
| Config text (`*_codes.txt`, `nemo_parameters.properties`, `mds.rc`) | rarely | silently wrong values | often never |

A tracking app that treats the NEI as one versioned blob will miss the failures that
actually happen, because in practice **one layer gets hot-patched on the server while the
others stay behind.**

---

## 4. Runtime layout and the per-run artifact tree

Install root observed in production:

```
/data/cloud-user/om/install/sas/bin/macro_server/java/CLICR/ANY/V1/
```

Each execution is identified by a **`CHILD_REQ_ID`** — a bare integer (`589`, `648`, `751`).
It is the only correlation key the system produces, and it is the root of the run's tree
on shared storage:

```
/mnt/shared_data/<CHILD_REQ_ID>/
├── <NODE_NAME>/                          one per target node
│   ├── Precheck/    <host>_config.txt            full pre-activity dump
│   │                <host>_<Table>_<NG>_Precheck.txt   per node-group, per table
│   ├── Postcheck/   <host>_config.txt            full post-activity dump
│   │                <host>_<Table>_<DATE>_Postcheck.txt
│   └── Rollback/    <host>_config.txt
│                    <host>_<Table>_<DATE>_<NG>_Rollback_{pre,post}check.txt
├── LOGS/            <NODE_NAME>_execution.log    the authoritative trace
│                    <NODE_NAME>_*_Comparison_Report.html
├── REPORT/          *_EXECUTION_REPORT_<NODE>.json
│                    *_CR<n>_{SUMMARY,FAILURE}_REPORT.html
├── MOP/             *-CR<n>.html                 method of procedure
└── FAIL_REPORT/<NODE>/*_EXECUTON_FAILURE_REPORT.html
```

Sizes are not trivial: a whole-config comparison report is **~6 MB** and a node config
dump ~415 KB. A tracking app that ingests artifacts needs a retention story.

### Execution phases

Every run walks a fixed phase sequence, recorded in the log as `=== Phase Start/End ===`:

```
PRE_NODE_HEALTH_CHECK → BACKUP → ACTIVITY_CONFIGURATION
                              → POST_NODE_HEALTH_CHECK → ROLLBACK_CONFIGURATION
```

`ROLLBACK_CONFIGURATION` runs when `ROLLBACK_REQUIRED` was set by a failing step.
The log ends with a `[SUMMARY]` block giving `overall_status`, `steps_total`, and per-phase
success/failed counts — the cheapest thing for an app to parse.

---

## 5. The identity model — four names for one thing

This is the single most confusing part of the system and a guaranteed source of bugs in
any tool that joins data across sources. **A "node" has four different identifiers:**

| Identifier | Example | Where it lives | What it identifies |
|---|---|---|---|
| `NODE_NAME` | `DRDLCFXA`, `BHPPNCFQD1` | CIQ `nodes[].node`, log filenames, report filenames | the logical node in the CIQ and in reporting |
| `HOSTNAME` | `lab01cci02` | inside artifact filenames (`lab01cci02_config.txt`) | the actual host the dump came from |
| `niamID` | `CFX_CIF_02_10.71.138.167-CLI` | CIQ `nodes[].niamID` / `niamID1` / `niamID2` | the NIAM credential/connection record used to reach it |
| `UNIQUEID` | `Labcscf/Labcfx01_DU/23.8/Ep0dH5M1` | read off the node at runtime | the element's own CM identity, used in every `cmcli` call |

They are **not** interchangeable and there is no mapping table — the relationship is
implicit in the CIQ and in runtime discovery. Two live consequences already observed:

- Artifacts are named by `HOSTNAME` but reports and logs by `NODE_NAME`. Two nodes in one
  CR can produce dumps with the *same* filename in different directories.
- A tool that filters by "node" must know which of the four the caller means. A recent
  defect in the comparison script came from exactly this: `--node` took a `NODE_NAME` and
  had to be matched against the CIQ's `nodes[].node`, and any other identifier silently
  matched nothing.

---

## 6. The CIQ — the change request format

Schema v2, JSON. This is the input a tracking app will most want to model.

```
{ "schemaVersion": "2",
  "meta": {
    "nodeType": "CFX",                      CFX | SBC | DPA | MRF | ...
    "activity": "128_TGRP_CONFIG_IN_CFX",   the activity/use-case identifier
    "tableKeys": {                          per-table metadata, NOT always complete
      "<Table>": { "recordPrimaryKeys": "Tgrp",          single or "VN_ID,TG_ID" composite
                   "subrecordKeys": {...},               nested-record keys
                   "immutableFields": {"record": [...]}} }},
  "nodeGroups": [{
    "nodeGroup": "CFXA",                    the batching unit
    "crGroup": "CR1",
    "email": "...",
    "nodes": [{ "node": "DRDLCFXA", "niamID": "...", "version": "CFX v24.7" }],
    "configSequences": [{
      "configSeq": "Step1",                 ordered execution steps
      "tables": [{
        "table": "System.TrunkGroupTable",
        "pk": "Tgrp",
        "component": "ims/cscf/bgcf",
        "records": [{ "data": {
            "NodeGroup": "CFXA",
            "Action": "CREATE",             CREATE | MODIFY | DELETE
            "Tgrp": "Test2",                the columns themselves
            "NextHop": "sip:Test2@mgcfpool",
            "primaryKey": "Test2",
            "value": "Tgrp=Test2 NextHop=..."   pre-rendered CLI argument
        }}]}]}]}]}
```

**Nesting to model:** `CIQ → nodeGroups → nodes` and `nodeGroups → configSequences →
tables → records`. Node groups map to *nodes*, and in real CIQs **different node groups
target different nodes** — so "which records apply to this node" is a join, not a filter.

**Schema variance is real.** The `tableKeys` map can contain non-table entries
(`"_optional": true` appears in a live SBC CIQ). Tables can omit `pk` entirely. Records can
omit `Action` and `primaryKey`. Some CIQs add `CONFIG_SEQ`, `SubAction`, `category`.
Anything consuming CIQs must tolerate all of this rather than assume the CFX shape.

---

## 7. Where the tracking problem actually bites

This is the part worth designing for, because every item below is something that *has
already caused a production failure or a wasted debugging session in this project*.

### 7.1 The same file exists in many places, silently divergent

One Python script was simultaneously present at:

```
version/netconf_compare_xml.py                                 the working copy
version/cfx/netconf_compare_xml.py                             a run-specific copy
version/648/netconf_compare_xml.py                             another run-specific copy
src/main/resources/script/python/netconf_compare_xml.py        the repo copy (what ships)
/data/.../CLICR/ANY/V1/script/python/netconf_compare_xml.py    the deployed copy
```

with **five different contents**. A whole day was lost to a bug that had already been
fixed — in a copy that was not the deployed one. There is no version stamp in the file
and no way to tell from a report which build produced it.

> **Requirement:** identity by content hash, not by path. Every artifact a run produces
> should record the hash of every code file that ran.

### 7.2 Compiled Java goes stale against its source

A YAML parse failure (`Cannot create property 'category'`) was diagnosed for a long time
as bad YAML indentation. The real cause was a stale `NodeDefinition.class` in `target/`
that predated the `category` field — SnakeYAML binds strictly against the *compiled*
bean, so the source was right and the class file was wrong.

> **Requirement:** track `.class`/`.jar` build time against source mtime, and surface
> "compiled artifact older than source" as a first-class warning.

### 7.3 The deployed copy drifts from the repo copy

Run 511 failed with 5 false errors. Cause: the server's Python script was an older build
that lacked a per-table loop. The repo copy was correct. Nothing in the run output
indicated which build had executed — it had to be inferred from a single differing log
line (`Scope : table None` vs `Scope : whole config, 3 CIQ table(s)`).

> **Requirement:** the deployed artifact must be able to answer "what version am I".
> Cheapest fix: have each script print its own content hash into the run log.

### 7.4 Cloud-sync silently reverts working files

The working directory is inside OneDrive. Files were repeatedly re-synced mid-session,
reverting edits with no error. Edits were lost this way more than once, including a
whole YAML block and a set of Python fixes.

> **Requirement:** do not treat a synced folder as a source of truth. The app should
> read from git or from a hash-addressed store, never from a live sync folder.

### 7.5 Runs are not linked to the code that produced them

`CHILD_REQ_ID` identifies a run. Nothing links a run to a code version, a CIQ version,
or an environment. Two runs of "the same" activity minutes apart can execute different
code, and the only evidence is incidental differences in log wording.

> **Requirement:** the core entity is a *run*, and it must reference immutable versions
> of (NEI package, YAML template, Python scripts, CIQ, target node).

### 7.6 Run directories are reused

`/mnt/shared_data/<CHILD_REQ_ID>/` is reused across re-runs of the same CR, and in one
observed case baselines lived in a *different* run's directory (`/mnt/shared_data/bkup/`)
while reports went to the current one. Artifacts from different executions were mixed in
one tree.

> **Requirement:** artifacts must be immutable and addressed per execution attempt, not
> per CR.

### 7.7 Secrets sit in a tracked config file

`src/main/resources/config/mds.rc.add` contains plaintext `CMM_PASSWORD`, `M2MPASSWORD`,
`REPO_PASSWORD`, and host addresses. Any tool that ingests, diffs, or displays config
must treat this file as sensitive — do not render it into a UI or ship it to a log store.
Worth separating into a secret reference before the tracking app touches it.

---

## 8. Suggested entity model for the app

Minimal set that covers the failures above:

```
Environment        dev | staging | prod        install root, host, credentials ref
NeiPackage         version, build time, content hash of the .jar
CodeFile           path, layer (java|python|yaml|config), content hash, source commit
Deployment         Environment × NeiPackage × {CodeFile}   when, by whom
                   -- the set of hashes ACTUALLY on that environment
Ciq                nodeType, activity, schemaVersion, content hash
Node               NODE_NAME, HOSTNAME, niamID, UNIQUEID, Environment
NodeGroup          name, crGroup, → [Node]
Run                CHILD_REQ_ID + attempt, → Deployment, → Ciq, → [Node],
                   phases[], overall_status, started, ended
Artifact           → Run, kind (dump|log|report|mop), path, size, content hash
Finding            → Run, phase, step id, severity, message
```

The join that matters and does not exist today: **`Run → Deployment`**. Everything else
is reporting; that edge is what makes a failure diagnosable.

### Invariants worth enforcing

1. A `Run` cannot exist without a resolved `Deployment` — refuse to record an
   unattributable run rather than store it with a null.
2. `CodeFile.content_hash` is the identity. Path and mtime are metadata.
3. A `Deployment` to `prod` must be byte-identical to a `Deployment` that already exists
   in `staging`. Promotion copies hashes; it never rebuilds.
4. `Artifact` is immutable. Re-running a CR creates a new attempt, never overwrites.
5. Compiled artifacts carry the hash of the sources they were built from.

---

## 9. Constraints any tooling must respect

- **Java 8** for anything in the NEI package. **Python 2** for the shipped scripts —
  no f-strings, and `str()` on non-ASCII raises. The tracking app itself can use anything;
  its *agents on the server* cannot.
- **`.packinglist` is the source of truth for what deploys.** Adding a file to the repo
  does not deploy it. This has bitten before: a Python script existed in the repo and was
  absent on the server until `.packinglist` was updated.
- **Strict YAML binding.** The workflow loader binds YAML onto Java beans and throws on
  an unknown key. Any tool that generates or rewrites YAML must validate against the
  compiled model, not against a schema copy.
- **Command-line length ceiling.** Linux `MAX_ARG_STRLEN` is 128 KB per argument. Node
  content is moved around by `echo '<base64>' | base64 -d`, which caps usable file size
  at ~96 KB of raw content. Larger files must go over SFTP. A 415 KB config dump cannot
  be transported inline.
- **`ROLLBACK_REQUIRED`** is the flag that turns a step failure into a rollback phase.
  Anything reasoning about run outcomes needs to understand that a "FAIL" run may have
  fully rolled back and left the node clean — failure of the run is not damage to the node.

---

## 10. Fastest ways to get real answers

- `LOGS/<NODE>_execution.log` — grep `\[SUMMARY\]` for the verdict, `\[ERROR\] FAILURE`
  for the failing step (it prints the full command), `=== Phase` for the timeline.
- `.packinglist` — the definitive list of what ships and where.
- `mds.rc.add` — how the NEI is wired to the server (and where the secrets are).
- `Constants.java` — task parameter names, phase codes, error codes, trace levels.
- `MopExecutionUtil.java` (~63 KB) — the real execution engine; the largest and most
  behaviour-dense file in the NEI.
- `templates/yaml/*.yaml` — the actual behaviour of any activity. The Java is an engine;
  the YAML is the program.

---

## 11. Things I am not certain about

Stated explicitly so nobody treats them as established:

- Whether the Macro Server supports multiple NEI versions side by side, or whether
  `CLICR/ANY/V1` is a hard singleton per install.
- How `CHILD_REQ_ID` is allocated, and whether it is unique across environments or only
  within one.
- Whether `nemo_*` (`nemo_setup.ksh`, `nemo_parameters.properties`, the `drop_nemo.sql`
  scripts for Oracle and Postgres) is a live database-backed subsystem or vestigial. It
  ships, but nothing observed in a run touched it.
- Whether NIAM connection records are themselves versioned, and whether they should be
  in scope for promotion.
