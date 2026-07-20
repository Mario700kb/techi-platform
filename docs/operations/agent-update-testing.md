# Testimi i Agjentit v2.1.3 — Domain (GPO) dhe Klient

Ky manual përshkruan si të testosh agjentin e ri **pa e prekur prodhimin
ekzistues** dhe pa u kapur nga AV/AMSI (Symantec, CybeeAI). Data: 2026-07-03.

> **Current Agent 2.1.16 note (2026-07-20):** Agent 2.1.16 is
> implementation-complete and locally validated, but production canary is
> pending. For rollback production backend `92a521c`, the expected communication
> contract is Agent 2.1.6-compatible: existing devices with `agent_id` +
> `device_id` must work without re-enrollment, no `agent_credential` is required,
> no auth migration endpoints are called, and no signed heartbeat /
> `X-Techi-Agent-*` headers are sent. Before any fleet rollout, canary an older
> 2.1.5/2.1.6 device through self_update to 2.1.16 and verify heartbeat,
> Operational state, Command Center action execution, One-Time Script execution,
> and self-update completion.
>
> **Deployment-script warning:** the current GPO/MSI deployment path can report
> `result=uptodate` from MSI/registry version even when the live executable was
> replaced by self_update. Add a future drift fix that compares the live
> `techi-agent.exe` hash or embedded version with the approved artifact, detects
> registry/live-binary mismatch, and forces repair/reinstall when drift exists.

## Konteksti i paketave

Tri lloje paketash, të gjitha aktive njëkohësisht në UI → Agent Packages:

| Tab | file_type | Përmban | Përdoret nga |
|-----|-----------|---------|--------------|
| MSI Packages | `msi` | agjenti **+** TECHI Remote Support | GPO/NETLOGON bootstrap, PC të reja |
| Agent Binary | `agent_binary` | vetëm techi-agent.exe | self_update (agjentë ≥ 2.1.1) |
| Update MSI (Bridge) | `agent_update_msi` | vetëm agjenti (pa RS) | self_update (agjentë < 2.1.1) |

Endpoint-et publike (pa token):
- `/api/v1/agent-packages/platform/windows-amd64/download` → **combined MSI** (bootstrap)
- `/api/v1/agent-packages/agent-update-msi/download` → **bridge MSI**
- `/api/v1/agent-packages/agent-binary/download` → **agjenti exe**

Që të tri mund të jenë aktive pa konflikt. Aktivizimi i njërës nuk çaktivizon
tjetrën.

## Përgatitja (një herë, para çdo testimi)

Nga GitHub Actions (run i fundit i `build-agent-msi` në `stable/phase-2-heartbeat`,
seksioni Artifacts) shkarko dhe ngarko në UI:

1. **Agent Binary tab** → `techi-agent.exe` v2.1.3 → Activate.
   (Ose exe-ja lokale e verifikuar:
   `/private/tmp/techi-agent-2.1.3-native-bootstrap.exe`,
   SHA256 `94a0bda42c929d2521b450f7edffd65dba04cc7fc36c1cf8a3faf2e55033874e`.)
2. **Update MSI (Bridge) tab** → `TECHI-Agent-Update-2.1.3.msi` → Activate.
3. **MSI Packages tab** → `TECHI-Endpoint-Deployment-2.1.3.msi` (combined) → Activate.

Verifiko që të tri endpoint-et kthejnë file-in e duhur:

```bash
for ep in platform/windows-amd64/download agent-update-msi/download agent-binary/download; do
  curl -s -o /dev/null -D - -r 0-0 "https://api-rdp.techi.com.al/api/v1/agent-packages/$ep" \
    | grep -iE '^HTTP|content-disposition'
done
```

Prit: combined → `platform`, bridge → `agent-update-msi`, exe → `agent-binary`.

---

## A) Testimi në një DOMAIN me GPO

Combined MSI-ja e re është script-free: bootstrap-i i PC-ve funksionon edhe në
domain-e me Symantec/CybeeAI (më parë PS-i bllokohej dhe config/service mbeteshin
gjysmë).

1. **Gjenero script-in e deploy-it**: UI → Deployments → zgjidh domain-in e
   testit → kopjo script-in PowerShell.
2. **Ekzekutoje në DC** (Domain Controller) me llogari admin. Script-i:
   - shkarkon MSI-në aktive combined nga `/platform/.../download` te NETLOGON
     si `TECHI-Agent-<version>.msi`;
   - shkruan `techi-version.txt`;
   - krijon GPO-në me scheduled task + GPO-në e Defender exclusions.
   > Shënim: `techi-deploy.cmd` që shkon në NETLOGON është CMD + msiexec (pa PS),
   > i sigurt ndaj AMSI. Vetë ekzekutimi i script-it gjenerator në DC është PS —
   > ekzekutoje në DC ku s'ka AV strikt, jo në një klient.
3. **Testo në 1–2 PC** (jo gjithë OU-në):
   ```cmd
   gpupdate /force
   schtasks /Run /TN "TECHI Agent Deploy"   :: emri sipas GPO-së
   ```
4. **Verifiko**:
   - UI → pajisja shfaqet ONLINE, `agent_version` i ri, `agent_sha256` i raportuar;
   - `C:\ProgramData\TechiAgent\deploy.log` ka `[bootstrap-config] config created`
     dhe `[rs-tray-task] task registered` (jo gabime PS);
   - `sc query TechiAgent` → RUNNING;
   - TECHI Remote Support lidhet (RS s'preket nga bridge, dhe combined e rikonfiguron);
   - `schtasks /Query /TN "TECHI Remote Support Tray"` ekziston.
5. Nëse OK, zgjero në gjithë OU-në.

**GPO/NETLOGON ekzistues nuk preket** derisa të aktivizosh combined 2.1.3 dhe të
rigjenerosh script-in. Deri atëherë PC-të vazhdojnë me combined-in aktual.

---

## B) Testimi për një KLIENT (self_update nga UI)

### B1. Klientë normalë (pa AV strikt) — agjentë ≥ 2.1.1

1. UI → Command Center → **Përditëso Agjentin** (self_update) → një device test.
2. Merr payload-in EXE (`agent-binary`), swap native, ~20–30 sek.
3. Verifiko: statusi COMPLETED "verified by heartbeat", `agent_sha256` i ri.
4. Zgjero në grupe ≤50.

### B2. Klientë me Symantec / CybeeAI

- **Agjentë ≥ 2.1.2**: self_update nga UI funksionon drejtpërdrejt — swap-i
  është native (pa PS), AV s'ka çfarë bllokon. Testo si B1.
- **Agjentë ≤ 2.1.1 (kanë ende swap me PS)**: hapi i parë **nuk** bëhet nga UI;
  bëje njëherë manualisht përmes RDP/TECHI Remote Support, në CMD (jo PS):
  ```cmd
  certutil -urlcache -split -f "https://api-rdp.techi.com.al/api/v1/agent-packages/agent-update-msi/download" C:\Windows\Temp\bridge.msi
  msiexec /i C:\Windows\Temp\bridge.msi /quiet
  ```
  Pas ~1 min pajisja raporton versionin e ri + SHA. Që nga ai moment, self_update
  nga UI punon normalisht edhe në atë klient.

### B3. Verifikimi i një self_update të dështuar

Nëse një device del "timeout" ose "executing" gjatë:
- UI action history → shiko `result_message`/`error_message`;
- në device `C:\ProgramData\TechiAgent\deploy.log` → kërko `[self_update]`
  (task launched, complete, ose failed/rollback);
- `agent.log` → gabime download/checksum.

---

## Rregulli i artë

- **Mos dërgo self_update drejt agjentëve 2.1.0** para se bridge MSI `agent_update_msi`
  me versionin e synuar të jetë aktive — backend-i i refuzon me mesazh të qartë.
- **Combined MSI aktive** duhet të jetë gjithmonë versioni që do në NETLOGON për
  bootstrap; mos e lër bridge-in të bëhet i vetmi MSI aktiv.
- Testo gjithmonë 1–2 pajisje para flotës; dallgë ≤50 me 2 min pauzë (download load).
