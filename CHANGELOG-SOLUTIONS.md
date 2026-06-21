# CHANGELOG-SOLUTIONS

Regjistër i ndryshimeve të konfirmuara me teste para deploy-it.

---

## 2026-06-21 — Simplifiko path-detection për :manual_replace në techi-deploy.cmd

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`

**Problem:** Seksioni `:manual_replace` përdorte `if/else if` chain me 4 path-e alternative
për të gjetur `techi-agent.exe` pas `msiexec /a` (administrative install/extract):

```bat
set EXTRACTED_AGENT=
if exist "%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\PFiles64\TECHI Agent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\PFiles64\TECHI Agent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\CommonAppData\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommonAppData\TechiAgent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\TechiAgent\techi-agent.exe"
)
```

**Zgjidhje:** Konfirmuar me 3×3 teste në makina të ndryshme Windows se path-i i vetëm i qëndrueshëm
është `CommApp\TechiAgent\techi-agent.exe`, i dokumentuar gjithashtu në `installer.wxs` si i garantuar
nga MSI packaging. U hoqën 3 `else if` të tjerë; u standardizua inicializimi i variablit me kuota.

```bat
set "EXTRACTED_AGENT="
if exist "%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe"
)
```

**Arsye:** Heqja e path-eve alternative eliminon ambiguitetin, zvogëlon sipërfaqen e gabimeve,
dhe e bën kodin konsistent me strukturën e garantuar nga MSI-ja.
