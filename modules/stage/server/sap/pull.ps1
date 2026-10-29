# ============================================================
#  Staging Lane Health - SAP GUI driver
#
#  One invocation = one full pull cycle (HU staging, orders, warehouse
#  tasks), or a probe, or a monitor tree dump. The Node service schedules
#  it, reads the JSON lines below from stdout, and kills it if it hangs.
#
#  Ported line for line from Start_HU_Staging_Pull.vbs (Aug 2026), so every
#  SAP quirk that script learned is kept:
#    - picks the SAP session already in the monitor, not just the first one
#    - reaches /SCWM/MON by transaction code, never by favourites position
#    - finds each result grid by a column only it carries
#    - checks which export window is on screen before confirming it
#    - writes to a temp folder, closes Excel, then renames into place
#    - refuses to save the order grid under the task file name
#
#  Exit codes: 0 ok, 2 SAP GUI not reachable, 3 session not ready, 4 tree
#  not reachable, 1 other failure.
# ============================================================
param(
  [string]$Action = 'pull',
  [string]$ReportDir = 'C:\REPORT',
  [string]$StageFile = 'HU STAGING.XLSX',
  [string]$OrdersFile = 'Orders.XLSX',
  [string]$WhFile = 'WHTask.XLSX',
  [string]$Warehouse = '0103',
  [string]$Monitor = 'zarden',
  [int]$LookbackDays = 3,
  [int]$SettleMs = 4000,
  [int]$SwitchMs = 6000,
  [string]$DateFormat = 'MM/dd/yyyy',
  [string]$HuNode = 'N000000211', [string]$HuLabel = '', [string]$HuExpand = 'C000000011,N000000014',
  [string]$OrdersNode = 'N000000011', [string]$OrdersLabel = '', [string]$OrdersExpand = '',
  [string]$WtNeedCols = 'TOSTAT=Warehouse Task Status',   # task layout must show these (tech=text, comma separated); blank = never touch the layout
  [string]$WtNode = 'N000000275', [string]$WtLabel = 'Warehouse Task', [string]$WtExpand = 'N000000108', [string]$WtParent = 'Documents',
  [string]$HuParent = '', [string]$OrdersParent = '',
  [string]$BinPatterns = 'e*,I*,D8*,F*,TOTE*'
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$script:session = $null
$script:connection = $null
$script:application = $null
$TmpDir = Join-Path $ReportDir 'tmp'

# ---------------- output ----------------
function Emit($obj){ [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }
function Log($msg, $level = 'info'){ Emit @{ t = 'log'; msg = [string]$msg; level = $level } }
function Phase($p){ Emit @{ t = 'phase'; phase = $p } }
function Fail($msg){ Emit @{ t = 'error'; msg = [string]$msg } }
function Sleep-Ms($ms){ if($ms -gt 0){ Start-Sleep -Milliseconds $ms } }

# ---------------- SAP helpers ----------------
function S($id){ return $script:session.findById($id) }
function Exists($id){ try { $null = $script:session.findById($id); return $true } catch { return $false } }
function Try-Step($label, [scriptblock]$b){
  try { & $b; return $true } catch { Log ("$label FAILED: " + $_.Exception.Message) 'warn'; return $false }
}
function Quiet([scriptblock]$b){ try { & $b } catch {} }

# Two ways to reach a running SAP GUI: the running-object table directly, and
# SAP's own ROT wrapper (SapROTWr), which is what SAP documents for anything
# that is not VBScript. When both fail, say exactly why: the error text, the
# PowerShell language mode (a locked-down PC forbids COM in
# ConstrainedLanguage mode) and whether SAP GUI is even running.
function Attach(){
  $errs = @()
  # 1. What VBScript's GetObject("SAPGUI") really does: a running-object-table
  #    lookup by display name. Visual Basic's GetObject exposes the same call.
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop
    $gui = [Microsoft.VisualBasic.Interaction]::GetObject('SAPGUI')
    if($gui -ne $null){
      $script:application = $gui.GetScriptingEngine()
      if($script:application -ne $null){ Log 'attached via VisualBasic GetObject'; return $true }
      $errs += 'GetObject(SAPGUI): no scripting engine (Enable scripting off in SAP GUI options?)'
    } else { $errs += 'GetObject(SAPGUI) returned nothing' }
  } catch { $errs += ('GetObject(SAPGUI): ' + $_.Exception.Message) }
  # 2. SAP's ROT helper, when its type library is loadable
  try {
    $rot = New-Object -ComObject 'SapROTWr.SapROTWrapper'
    $gui = $rot.GetROTEntry('SAPGUI')
    if($gui -ne $null){
      $script:application = $gui.GetScriptingEngine()
      if($script:application -ne $null){ Log 'attached via SapROTWr'; return $true }
      $errs += 'SapROTWr: no scripting engine (scripting disabled in SAP GUI options?)'
    } else { $errs += 'SapROTWr: no SAPGUI entry in the running object table (SAP GUI not logged in, or running in another Windows session)' }
  } catch { $errs += ('SapROTWr: ' + $_.Exception.Message + $(if([Environment]::Is64BitProcess){ ' (64-bit PowerShell cannot load this 32-bit DLL; the service should launch the SysWOW64 PowerShell)' } else { '' })) }
  # 3. the same helper through raw IDispatch, which needs no type library
  try {
    $t = [Type]::GetTypeFromProgID('SapROTWr.SapROTWrapper')
    if($t -eq $null){ throw 'ProgID SapROTWr.SapROTWrapper is not registered' }
    $rot2 = [Activator]::CreateInstance($t)
    $gui = $t.InvokeMember('GetROTEntry', [Reflection.BindingFlags]::InvokeMethod, $null, $rot2, @('SAPGUI'))
    if($gui -ne $null){
      $script:application = $gui.GetType().InvokeMember('GetScriptingEngine', [Reflection.BindingFlags]::InvokeMethod, $null, $gui, $null)
      if($script:application -ne $null){ Log 'attached via SapROTWr (IDispatch)'; return $true }
      $errs += 'SapROTWr/IDispatch: no scripting engine'
    } else { $errs += 'SapROTWr/IDispatch: no SAPGUI entry in the running object table' }
  } catch { $errs += ('SapROTWr/IDispatch: ' + $_.Exception.Message) }
  # 4. last resort
  try {
    $gui = [System.Runtime.InteropServices.Marshal]::GetActiveObject('SAPGUI')
    $script:application = $gui.GetScriptingEngine()
    if($script:application -ne $null){ Log 'attached via GetActiveObject'; return $true }
    $errs += 'GetActiveObject returned no scripting engine'
  } catch { $errs += ('GetActiveObject: ' + $_.Exception.Message) }
  $procs = @(Get-Process -Name saplogon, sapgui, saplgpad -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + '(' + $_.Id + ')' }) -join ', '
  if(-not $procs){ $procs = 'none' }
  $mode = ''; try { $mode = [string]$ExecutionContext.SessionState.LanguageMode } catch {}
  $bits = $(if([Environment]::Is64BitProcess){ '64-bit' } else { '32-bit' })
  $detail = 'SAP GUI not reachable. ' + ($errs -join ' | ') + '. PowerShell ' + $bits + ', language mode ' + $mode + ', SAP processes: ' + $procs
  Log $detail 'error'
  Emit @{ t = 'sap'; ok = 0; tcode = ''; detail = $detail }
  return $false
}
function Tcode(){ try { return ([string]$script:session.Info.Transaction).Trim().ToUpper() } catch { return '' } }
function Prog(){ try { return ([string]$script:session.Info.Program).Trim().ToUpper() } catch { return '' } }
function WindowTitle(){ try { return ([string](S 'wnd[0]').Text).Trim() } catch { return '' } }

# Choose the SAP window to drive: one already in the monitor, else one whose
# command field is reachable, else the first.
function PickSession(){
  $app = $script:application
  $best = $null; $bestConn = $null; $bestWhy = ''
  $cCount = 1; try { $cCount = $app.Children.Count } catch {}
  for($ci = 0; $ci -lt $cCount; $ci++){
    $conn = $null; try { $conn = $app.Children.Item($ci) } catch { continue }
    $sCount = 1; try { $sCount = $conn.Children.Count } catch {}
    for($si = 0; $si -lt $sCount; $si++){
      $sess = $null; try { $sess = $conn.Children.Item($si) } catch { continue }
      $tc = ''; try { $tc = ([string]$sess.Info.Transaction).Trim().ToUpper() } catch {}
      if($tc -like '*MON*'){
        $script:connection = $conn; $script:session = $sess
        Log "session: using connection $ci session $si (already in $tc)"
        return
      }
      if($best -eq $null){
        try { $null = $sess.findById('wnd[0]/tbar[0]/okcd').Text; $best = $sess; $bestConn = $conn; $bestWhy = "connection $ci session $si (command field reachable, in $tc)" } catch {}
      }
    }
  }
  if($best -ne $null){ $script:session = $best; $script:connection = $bestConn; Log "session: using $bestWhy"; return }
  try { $script:connection = $app.Children.Item(0); $script:session = $script:connection.Children.Item(0); Log ("session: falling back to connection 0 session 0 (" + (Tcode) + ")") } catch { $script:session = $null }
}

function HasModal(){ return (Exists 'wnd[1]') }
function DismissPopups(){
  for($i = 0; $i -lt 8; $i++){
    if(-not (HasModal)){ return }
    Quiet { (S 'wnd[1]').close() }
    if(HasModal){ Quiet { (S 'wnd[1]').sendVKey(0) } }
    Sleep-Ms 300
  }
}
function ClearModals(){
  for($i = 0; $i -lt 4; $i++){
    if(Exists 'wnd[2]'){ Quiet { (S 'wnd[2]').sendVKey(12) }; Sleep-Ms 250 }
    if(Exists 'wnd[1]'){ Quiet { (S 'wnd[1]').sendVKey(12) }; Sleep-Ms 250 }
    if(-not (Exists 'wnd[1]')){ return }
  }
}
function CurrentScreen(){
  $tx = Tcode; $pg = Prog
  if($tx -like '*/SCWM/MON*' -or $pg -like '*WME_MONITOR*'){ return 'REPORT' }
  if($tx -eq 'SESSION_MANAGER'){ return 'MAIN' }
  return 'OTHER'
}
function StatusMsg(){
  $t = ''; $ty = ''
  try { $t = [string](S 'wnd[0]/sbar').Text } catch {}
  try { $ty = [string](S 'wnd[0]/sbar').MessageType } catch {}
  if(-not $t.Trim()){ try { $t = [string](S 'wnd[1]/sbar').Text } catch {} }
  if(-not $t.Trim()){ $t = '(no message)' }
  return ("$ty $t").Trim()
}

# Get to the /SCWM/MON tree whatever the session was doing. Returns the tree
# object or $null.
function GoToMonitorTree(){
  DismissPopups
  $tc = Tcode
  if($tc -like '*MON*'){
    try { return (S 'wnd[0]/usr/shell/shellcont[0]/shell') } catch {}
    for($i = 1; $i -le 3; $i++){
      Quiet { (S 'wnd[0]/tbar[0]/btn[3]').press() }
      Sleep-Ms 500
      DismissPopups
      try { $t = S 'wnd[0]/usr/shell/shellcont[0]/shell'; Log "returned to the monitor tree after $i back press(es)"; return $t } catch {}
    }
  }
  for($i = 1; $i -le 3; $i++){
    ClearModals
    $okcd = $false
    try { (S 'wnd[0]/tbar[0]/okcd').text = '/n/SCWM/MON'; $okcd = $true } catch { Log ("command field unreachable (attempt $i); tcode is " + (Tcode)) 'warn'; Sleep-Ms 700 }
    if($okcd){
      Quiet { (S 'wnd[0]').sendVKey(0) }
      Sleep-Ms 1200
      if(Exists 'wnd[1]/usr/ctxtP_LGNUM'){
        Quiet { (S 'wnd[1]/usr/ctxtP_LGNUM').text = $Warehouse }
        Quiet { (S 'wnd[1]/usr/ctxtP_MONIT').text = $Monitor }
        Quiet { (S 'wnd[1]/usr/txtP_REFR').setFocus() }
        Quiet { (S 'wnd[1]/usr/txtP_REFR').caretPosition = 3 }
        Quiet { (S 'wnd[1]/tbar[0]/btn[8]').press() }
        Sleep-Ms 1200
      }
      try { return (S 'wnd[0]/usr/shell/shellcont[0]/shell') } catch {}
      Log ("after attempt $i the session is in " + (Tcode) + " with no monitor tree") 'warn'
    }
  }
  Log ("gave up reaching /SCWM/MON. Session is in " + (Tcode) + " titled '" + (WindowTitle) + "'. Check that this login can run /SCWM/MON and that monitor $Monitor exists for warehouse $Warehouse.") 'error'
  return $null
}

# Resolve a tree node: by label when one is configured (positional keys drift
# when the monitor layout changes), otherwise the recorded key. A parent label
# disambiguates when the same text appears under two branches. Whatever is
# chosen, the log says which key and what text it carries, so a wrong node is
# visible instead of silent.
function NodeText($tree, $k){ try { return ([string]$tree.GetNodeTextByKey($k)).Trim() } catch { return '' } }
function ParentText($tree, $k){ try { $pk = [string]$tree.GetParent($k); if($pk){ return (NodeText $tree $pk) } } catch {}; return '' }
function ResolveNode($tree, $key, $label, $parent){
  $chosen = $key; $how = 'recorded key'
  if($label -and $label.Trim()){
    try {
      $keys = $tree.GetAllNodeKeys()
      $n = 0; try { $n = $keys.Count } catch { $n = $keys.Length }
      $exact = @(); $starts = @()
      for($i = 0; $i -lt $n; $i++){
        $k = [string]$keys.Item($i)
        $txt = (NodeText $tree $k).ToUpper()
        $want = $label.Trim().ToUpper()
        if($txt -eq $want){ $exact += $k } elseif($txt.StartsWith($want)){ $starts += $k }
      }
      $cands = @($exact + $starts)
      if($parent -and $parent.Trim() -and $cands.Count -gt 1){
        $under = @($cands | Where-Object { (ParentText $tree $_).ToUpper() -eq $parent.Trim().ToUpper() })
        if($under.Count -ge 1){ $cands = $under }
      }
      # A recorded key wins over a name match. Two nodes here are both
      # called 'Warehouse Task' under a parent called 'Warehouse Order',
      # so the name cannot choose between them and picking the first by
      # name means ignoring the one somebody configured.
      if($key -and ($cands -contains $key)){ $cands = @($key) + @($cands | Where-Object { $_ -ne $key }) }
      if($cands.Count -ge 1){
        $chosen = $cands[0]; $how = $(if($key -and $chosen -eq $key){ 'the recorded key' } else { "matched by name" + $(if($cands.Count -gt 1){ " (first of $($cands.Count))" } else { '' }) })
        # make sure it is visible: expand its parent chain
        try { $pk = [string]$tree.GetParent($chosen); $d = 0; while($pk -and $d -lt 6){ Quiet { $tree.expandNode($pk) }; $pk = [string]$tree.GetParent($pk); $d++ } } catch {}
      } else {
        Log "node '$label' not found by name, falling back to $key" 'warn'
      }
    } catch { Log ("node lookup by name failed: " + $_.Exception.Message + "; using $key") 'warn' }
  }
  Log ("node " + $chosen + " = '" + (NodeText $tree $chosen) + "' under '" + (ParentText $tree $chosen) + "' (" + $how + ")")
  return $chosen
}
function ExpandList($tree, $csv){
  foreach($k in ($csv -split ',')){ $k = $k.Trim(); if($k){ Quiet { $tree.expandNode($k) } } }
}

# ---- grids ----
function GridHasColumn($g, $colName){
  if(-not $colName){ return $false }
  try {
    $cols = $g.ColumnOrder
    $n = 0; try { $n = $cols.Count } catch { $n = $cols.Length }
    for($i = 0; $i -lt $n; $i++){ if(([string]$cols.Item($i)).Trim().ToUpper() -eq $colName.ToUpper()){ return $true } }
  } catch {}
  return $false
}
function GridColumnList($g){
  $out = @()
  try {
    $cols = $g.ColumnOrder
    $n = 0; try { $n = $cols.Count } catch { $n = $cols.Length }
    for($i = 0; $i -lt [Math]::Min($n, 14); $i++){ $out += [string]$cols.Item($i) }
    if($n -gt 14){ $out += ('+' + ($n - 14) + ' more') }
  } catch {}
  if(-not $out.Count){ return 'columns unreadable' }
  return ($out -join ',')
}
# Find the result grid for the node just opened, by column, never by index.
function FindResultGrid($avoidA, $avoidB, $wantCol){
  $fallback = $null; $fallbackPath = ''
  for($i = 0; $i -le 4; $i++){
    foreach($cand in @("wnd[0]/usr/shell/shellcont[$i]/shell/shellcont[0]/shell", "wnd[0]/usr/shell/shellcont[$i]/shell")){
      $g = $null
      try { $g = S $cand } catch { continue }
      if($g -eq $null){ continue }
      $rc = 0; try { $rc = [int]$g.RowCount } catch { continue }
      if($rc -le 0){ continue }
      if((GridHasColumn $g $avoidA) -or (GridHasColumn $g $avoidB)){ continue }
      if(-not $wantCol){ Log "grid: using $cand ($rc rows)"; return $g }
      if(GridHasColumn $g $wantCol){ Log "grid: using $cand ($rc rows, has $wantCol)"; return $g }
      if($fallback -eq $null){ $fallback = $g; $fallbackPath = $cand }
    }
  }
  if($fallback -ne $null){ Log "grid: using $fallbackPath (no $wantCol column, but not the order or HU grid)"; return $fallback }
  return $null
}

# ---- layout ----
# Which columns the task grid shows is the SAP user's saved layout, and the
# board needs Warehouse Task Status (TOSTAT) to tell a confirmed pick from an
# open one; a layout without it makes every pick look open. So before the
# export, any needed column that is missing is added through Change Layout.
# The change lasts for the SAP session, which the puller recycles now and
# then, so this runs on every task pull: one property read when nothing is
# missing, the dialog only when something is.
function WtNeeded(){
  $out = @()
  foreach($p in ([string]$WtNeedCols).Split(',')){
    $kv = $p.Split('=', 2); $t = $kv[0].Trim(); if(-not $t){ continue }
    $out += @{ tech = $t.ToUpper(); text = $(if($kv.Count -gt 1){ $kv[1].Trim() } else { $t }) }
  }
  return $out
}
function WalkGui($node, $type, $subType, [ref]$found){
  # every descendant of $node whose Type (and SubType, for shells) match
  try { if(([string]$node.Type) -eq $type -and ((-not $subType) -or (([string]$node.SubType) -eq $subType))){ $found.Value += ,$node } } catch {}
  $kids = $null; try { $kids = $node.Children } catch { return }
  if($kids -eq $null){ return }
  $n = 0; try { $n = $kids.Count } catch { $n = $kids.Length }
  for($i = 0; $i -lt $n; $i++){ $k = $null; try { $k = $kids.Item($i) } catch { continue }; if($k -ne $null){ WalkGui $k $type $subType $found } }
}
function GridFindRow($g, $names){
  # row index of the first cell, in any column, equal to one of $names; -1 if none
  $rc = 0; try { $rc = [int]$g.RowCount } catch { return -1 }
  $vis = 20; try { $vis = [Math]::Max(1, [int]$g.VisibleRowCount) } catch {}
  $cols = @()
  try { $co = $g.ColumnOrder; $cn = 0; try { $cn = $co.Count } catch { $cn = $co.Length }; for($c = 0; $c -lt $cn; $c++){ $cols += [string]$co.Item($c) } } catch { return -1 }
  $want = @($names | ForEach-Object { ([string]$_).Trim().ToUpper() })
  for($r0 = 0; $r0 -lt $rc; $r0 += $vis){
    Quiet { $g.firstVisibleRow = $r0 }
    for($r = $r0; $r -lt [Math]::Min($rc, $r0 + $vis); $r++){
      foreach($c in $cols){
        $v = ''; try { $v = ([string]$g.GetCellValue($r, $c)).Trim().ToUpper() } catch { continue }
        if($v -and ($want -contains $v)){ return $r }
      }
    }
  }
  return -1
}
function OpenLayoutDialog($g){
  if(HasModal){ DismissPopups }
  $null = Try-Step 'layout: open Change Layout' { $g.contextMenu(); $g.selectContextMenuItem('&COL0') }
  Sleep-Ms 900
  if(-not (HasModal)){ $null = Try-Step 'layout: open Change Layout from the toolbar' { $g.pressToolbarContextButton('&MB_VARIANT'); $g.selectContextMenuItem('&COL0') }; Sleep-Ms 900 }
  if(-not (HasModal)){ Quiet { (S 'wnd[0]').sendVKey(32) }; Sleep-Ms 900 }   # Ctrl+F8
  return (HasModal)
}
function EnsureWtColumns($g){
  # the task grid to export, found again after a layout change; $null if it was lost
  $need = @(WtNeeded)
  $missing = @($need | Where-Object { -not (GridHasColumn $g $_.tech) })
  if(-not $missing.Count){ return $g }
  Log ('WT: the task layout has no ' + (($missing | ForEach-Object { $_.text }) -join ', ') + ' column; adding it for this session')
  if(-not (OpenLayoutDialog $g)){ Log 'WT: Change Layout did not open; exporting the layout as it is' 'warn'; return $g }
  $added = 0
  foreach($m in $missing){
    # the dialog's first tab holds two lists: displayed columns and the column set
    $grids = @(); WalkGui (S 'wnd[1]') 'GuiShell' 'GridView' ([ref]$grids)
    $hit = $null; $row = -1
    foreach($lg in $grids){ $row = GridFindRow $lg @($m.tech, $m.text); if($row -ge 0){ $hit = $lg; break } }
    if($hit -eq $null){ Log ('WT: ' + $m.text + ' is not in the column set either (' + $grids.Count + ' lists searched)') 'warn'; continue }
    if(-not (Try-Step ('layout: select ' + $m.text) { $hit.selectedRows = [string]$row; $hit.currentCellRow = $row })){ continue }
    $btns = @(); WalkGui (S 'wnd[1]') 'GuiButton' '' ([ref]$btns)
    $show = $null
    foreach($b in $btns){ try { if((([string]$b.Name) -eq 'APP_WL_SING') -or (([string]$b.Tooltip) -match 'Show Selected')){ $show = $b; break } } catch {} }
    $ok = $false
    if($show -ne $null){ $ok = Try-Step ('layout: show ' + $m.text) { $show.press() } }
    else { $ok = Try-Step ('layout: show ' + $m.text + ' by double click') { $hit.doubleClickCurrentCell() } }
    if($ok){ $added++ }
    Sleep-Ms 400
  }
  if($added){ $null = Try-Step 'layout: confirm' { (S 'wnd[1]/tbar[0]/btn[0]').press() } }
  else { Quiet { (S 'wnd[1]').close() } }
  Sleep-Ms 1200
  DismissPopups
  # the grid object goes stale after a layout change: find it again
  $g2 = $null
  foreach($want in @('TANUM', 'VLTYP', 'TOSTAT', 'WHO', 'VLPLA', 'PROD_ORDER')){ $g2 = FindResultGrid 'STATUS_PICKING' 'FLGMOVE' $want; if($g2 -ne $null -and (GridHasColumn $g2 $want)){ break } else { $g2 = $null } }
  if($g2 -eq $null){ return $null }
  $still = @($need | Where-Object { -not (GridHasColumn $g2 $_.tech) })
  if($still.Count){ Log ('WT: still no ' + (($still | ForEach-Object { $_.text }) -join ', ') + ' after Change Layout; exporting anyway, the board copes') 'warn' }
  else { Log 'WT: the task layout now carries every column the board needs' }
  return $g2
}

# ---- Excel ----
function SuppressExcelFormatWarning(){
  foreach($v in @('16.0', '15.0', '14.0')){
    Quiet {
      $p = "HKCU:\Software\Microsoft\Office\$v\Excel\Security"
      if(-not (Test-Path $p)){ New-Item -Path $p -Force | Out-Null }
      Set-ItemProperty -Path $p -Name ExtensionHardening -Value 0 -Type DWord
    }
  }
}
# SAP opens each export in an isolated Excel. Kill it only when it is the
# only Excel running, so nobody's open spreadsheet is ever touched.
function CloseExportExcel(){
  $procs = @()
  for($t = 1; $t -le 6; $t++){
    $procs = @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue)
    if($procs.Count -ge 1){ break }
    Sleep-Ms 1000
  }
  if($procs.Count -eq 1){ Quiet { $procs[0] | Stop-Process -Force }; Log 'close: terminated the export''s Excel (only instance running)' }
  elseif($procs.Count -eq 0){ Log 'close: no Excel found to close' }
  else { Log ("close: " + $procs.Count + " Excel instances open, stood down (would hit your other files)") 'warn' }
}

# ---- files ----
function EnsureTmpDir(){ if(-not (Test-Path $TmpDir)){ Quiet { New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null } } }
function SameSizeAs($fname, $otherPath){
  if(-not $otherPath){ return $false }
  $src = Join-Path $TmpDir $fname
  if((Test-Path $src) -and (Test-Path $otherPath)){
    $a = (Get-Item $src).Length; $b = (Get-Item $otherPath).Length
    return ($a -gt 0 -and $a -eq $b)
  }
  return $false
}
function SwapIntoPlace($fname){
  $src = Join-Path $TmpDir $fname
  $dst = Join-Path $ReportDir $fname
  if(-not (Test-Path $src)){ Log "EXPORT MISSING: $src was not written" 'error'; return $false }
  for($i = 1; $i -le 6; $i++){
    try {
      if(Test-Path $dst){ Remove-Item $dst -Force -ErrorAction Stop }
      Move-Item $src $dst -Force -ErrorAction Stop
      $bytes = (Get-Item $dst).Length
      Emit @{ t = 'export'; file = $fname; bytes = $bytes }
      return $true
    } catch { Sleep-Ms 700 }
  }
  Log "SWAP FAILED for $fname; the previous copy is still in place" 'error'
  return $false
}

# Save the current ALV grid (export menu already opened) to a named file.
function ExportGridTo($fname, $rejectIfSameSizeAs){
  Sleep-Ms 700
  $isSave = (Exists 'wnd[1]/usr/ctxtDY_PATH')
  if(-not $isSave){
    Quiet { (S 'wnd[1]/usr/chkCB_ALWAYS').setFocus() }
    Quiet { (S 'wnd[1]/usr/chkCB_ALWAYS').selected = $true }
    $null = Try-Step "export: confirm format for $fname" { (S 'wnd[1]/tbar[0]/btn[0]').press() }
    Sleep-Ms 800
  }
  EnsureTmpDir
  $ok = Try-Step "export: path and name for $fname" {
    (S 'wnd[1]/usr/ctxtDY_PATH').text = $TmpDir
    (S 'wnd[1]/usr/ctxtDY_FILENAME').text = $fname
    (S 'wnd[1]/usr/ctxtDY_FILENAME').caretPosition = $fname.Length
  }
  if(-not $ok){ DismissPopups; return $false }
  $null = Try-Step "export: save $fname" { (S 'wnd[1]/tbar[0]/btn[11]').press() }
  Sleep-Ms 1000
  Quiet { (S 'wnd[1]/usr/btnBUTTON_1').press() }   # overwrite prompt
  DismissPopups
  Sleep-Ms $SettleMs
  CloseExportExcel
  if(SameSizeAs $fname $rejectIfSameSizeAs){
    Log "$fname came out the same size as $rejectIfSameSizeAs; that is the other report exported twice. Discarding it." 'error'
    Quiet { Remove-Item (Join-Path $TmpDir $fname) -Force }
    return $false
  }
  return (SwapIntoPlace $fname)
}

function YMD($offset){ return (Get-Date).AddDays($offset).ToString('yyyyMMdd') }
function HMS(){ return (Get-Date).ToString('HH:mm:ss') }
function SapDate(){ try { return (Get-Date).ToString($DateFormat) } catch { return (Get-Date).ToString('MM/dd/yyyy') } }

function SetTimeField($fieldId, $firstTry, $fallback){
  Quiet { (S $fieldId).text = $firstTry; (S $fieldId).setFocus(); (S $fieldId).caretPosition = 2 }
  $got = ''; try { $got = [string](S $fieldId).text } catch {}
  if($got.Trim() -ne $firstTry){
    Quiet { (S $fieldId).text = $fallback }
    try { $got = [string](S $fieldId).text } catch {}
    Log "WT: time field would not take $firstTry; now reads '$got'" 'warn'
  }
}
function CloseCalendar($which){
  if(Exists 'wnd[2]'){
    Log "WT: calendar still open after date $which; closing it"
    Quiet { (S 'wnd[2]/tbar[0]/btn[0]').press() }
    if(Exists 'wnd[2]'){ Quiet { (S 'wnd[2]').sendVKey(0) } }
  }
}
function SelectionStillOpen(){ return (Exists 'wnd[1]/usr/ctxtP_CDTFR') }
function KeepAwake(){ Quiet { (S 'wnd[0]/tbar[0]/okcd').text = ''; (S 'wnd[0]').sendVKey(0) } }

# ============================================================
#  The three pulls
# ============================================================
function RunHU(){
  Phase 'HU staging'
  $tree = GoToMonitorTree
  if($tree -eq $null){ Log 'HU: could not reach the monitor tree; skipping' 'error'; return $false }
  Quiet { (S 'wnd[0]').resizeWorkingPane(211, 28, $false) }
  ExpandList $tree $HuExpand
  $node = ResolveNode $tree $HuNode $HuLabel $HuParent
  $ok = Try-Step 'HU: open handling unit node' {
    $tree.selectedNode = $node
    Quiet { $tree.topNode = 'C000000001' }
    $tree.doubleClickNode($node)
  }
  if(-not $ok){ return $false }
  Sleep-Ms 800
  # storage bin multiple selection: the configured patterns
  $ok = Try-Step 'HU: open bin multi-selection' { (S 'wnd[1]/usr/btn%_S_LGPLA_%_APP_%-VALU_PUSH').press() }
  if($ok){
    $pats = @($BinPatterns -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $base = 'wnd[2]/usr/tabsTAB_STRIP/tabpSIVA/ssubSCREEN_HEADER:SAPLALDB:3010/tblSAPLALDBSINGLE/ctxtRSCSEL_255-SLOW_I[1,'
    for($i = 0; $i -lt $pats.Count; $i++){
      $id = $base + $i + ']'
      $null = Try-Step "HU: bin pattern $($pats[$i])" { (S $id).text = $pats[$i] }
    }
    if($pats.Count){ $last = $base + ($pats.Count - 1) + ']'; Quiet { (S $last).setFocus(); (S $last).caretPosition = $pats[$pats.Count - 1].Length } }
    $null = Try-Step 'HU: accept bin selection' { (S 'wnd[2]/tbar[0]/btn[8]').press() }
  }
  $null = Try-Step 'HU: execute' { (S 'wnd[1]/tbar[0]/btn[8]').press() }
  Sleep-Ms 1500
  DismissPopups
  $g = FindResultGrid 'STATUS_PICKING' '' 'FLGMOVE'
  if($g -eq $null){ Log 'HU: no handling unit grid on screen; leaving the previous file alone' 'error'; return $false }
  $ok = Try-Step 'HU: open export menu' { $g.setCurrentCell(5, 'FLGMOVE'); $g.contextMenu(); $g.selectContextMenuItem('&XXL') }
  if(-not $ok){ return $false }
  return (ExportGridTo $StageFile '')
}

function RunOrders(){
  Phase 'orders'
  $tree = GoToMonitorTree
  if($tree -eq $null){ Log 'Orders: could not reach the monitor tree; skipping' 'error'; return $false }
  Quiet { (S 'wnd[0]').resizeWorkingPane(211, 28, $false) }
  ExpandList $tree $OrdersExpand
  $node = ResolveNode $tree $OrdersNode $OrdersLabel $OrdersParent
  $ok = Try-Step 'Orders: open order node' { $tree.selectedNode = $node; $tree.doubleClickNode($node) }
  if(-not $ok){ return $false }
  Sleep-Ms 1000
  Quiet { (S 'wnd[1]/usr/ctxtS_DERI-LOW').text = '1' }
  Quiet { (S 'wnd[1]/usr/ctxtS_DERI-HIGH').text = '9' }
  Quiet { (S 'wnd[1]/usr/ctxtS_DGII-LOW').text = '0' }
  Quiet { (S 'wnd[1]/usr/ctxtS_DGII-HIGH').text = '1' }
  # creation date window via the calendar control (locale proof)
  $from = YMD (-$LookbackDays); $to = YMD 0
  Quiet { (S 'wnd[1]/usr/ctxtP_CDATFR').setFocus(); (S 'wnd[1]/usr/ctxtP_CDATFR').caretPosition = 0; (S 'wnd[1]').sendVKey(4) }
  Sleep-Ms 400
  Quiet { (S 'wnd[2]/usr/cntlCONTAINER/shellcont/shell').focusDate = $from; (S 'wnd[2]/usr/cntlCONTAINER/shellcont/shell').selectionInterval = "$from,$from" }
  CloseCalendar 'from'
  Quiet { (S 'wnd[1]/usr/ctxtP_CDATTO').setFocus(); (S 'wnd[1]/usr/ctxtP_CDATTO').caretPosition = 0; (S 'wnd[1]').sendVKey(4) }
  Sleep-Ms 400
  Quiet { (S 'wnd[2]/usr/cntlCONTAINER/shellcont/shell').focusDate = $to; (S 'wnd[2]/usr/cntlCONTAINER/shellcont/shell').selectionInterval = "$to,$to" }
  CloseCalendar 'to'
  Quiet { (S 'wnd[1]/usr/ctxtP_CTIMTO').text = (HMS) }
  $gotFr = ''; $gotTo = ''
  try { $gotFr = [string](S 'wnd[1]/usr/ctxtP_CDATFR').text; $gotTo = [string](S 'wnd[1]/usr/ctxtP_CDATTO').text } catch {}
  if($gotFr.Trim().Length -lt 6 -or $gotTo.Trim().Length -lt 6){
    Log 'Orders: calendar left the dates blank; typing them' 'warn'
    Quiet { (S 'wnd[1]/usr/ctxtP_CDATFR').text = (Get-Date).AddDays(-$LookbackDays).ToString($DateFormat) }
    Quiet { (S 'wnd[1]/usr/ctxtP_CDATTO').text = (SapDate) }
  }
  Log "Orders: window $gotFr to $gotTo"
  $null = Try-Step 'Orders: execute' { (S 'wnd[1]/tbar[0]/btn[8]').press() }
  Sleep-Ms 1500
  DismissPopups
  $g = FindResultGrid 'FLGMOVE' '' 'STATUS_PICKING'
  if($g -eq $null){ Log 'Orders: no order grid on screen; leaving the previous file alone' 'error'; return $false }
  $ok = Try-Step 'Orders: open export menu' { $g.setCurrentCell(5, 'STATUS_PICKING'); $g.contextMenu(); $g.selectContextMenuItem('&XXL') }
  if(-not $ok){ return $false }
  return (ExportGridTo $OrdersFile '')
}

function RunWhTask(){
  Phase 'warehouse tasks'
  $tree = GoToMonitorTree
  if($tree -eq $null){ Log 'WT: could not get back to the monitor tree; skipping' 'error'; return $false }
  Quiet { (S 'wnd[0]').resizeWorkingPane(211, 28, $false) }
  ExpandList $tree $WtExpand
  $node = ResolveNode $tree $WtNode $WtLabel $WtParent
  $ok = Try-Step 'WT: open Warehouse Task node' { $tree.selectedNode = $node; Quiet { $tree.topNode = 'C000000001' }; $tree.doubleClickNode($node) }
  if(-not $ok){ return $false }
  Sleep-Ms 1400
  # A node somebody chose on purpose is used even when its selection screen
  # is a different one, because refusing it means silently running the node
  # they were trying to get away from.
  $noDates = $false
  if(-not (Exists 'wnd[1]/usr/ctxtP_CDTFR')){
    if($WtNode){
      Log 'WT: this node opened a screen with no creation-date field. Using it anyway because it is the one configured; nothing is being restricted.' 'warn'
      $noDates = $true
    } else {
      Log 'WT: selection screen did not open after the node double click (node label differs on this monitor?)' 'error'
      return $false
    }
  }
  if($noDates){ Log 'WT: nothing is being restricted on this screen; running it as it stands' }
  else{
  $today = YMD 0
  Quiet { (S 'wnd[1]/usr/ctxtP_CDTFR').setFocus(); (S 'wnd[1]/usr/ctxtP_CDTFR').caretPosition = 0; (S 'wnd[1]').sendVKey(4) }
  Sleep-Ms 500
  $null = Try-Step 'WT: creation date from' { (S 'wnd[2]/usr/cntlCONTAINER/shellcont/shell').selectionInterval = "$today,$today" }
  CloseCalendar 'from'
  Quiet { (S 'wnd[1]/usr/ctxtP_CDTTO').setFocus(); (S 'wnd[1]/usr/ctxtP_CDTTO').caretPosition = 0; (S 'wnd[1]').sendVKey(4) }
  Sleep-Ms 500
  $null = Try-Step 'WT: creation date to' { (S 'wnd[2]/usr/cntlCONTAINER/shellcont/shell').selectionInterval = "$today,$today" }
  CloseCalendar 'to'
  SetTimeField 'wnd[1]/usr/ctxtP_CTMTO' '23:59:59' '24:00:00'
  if(Exists 'wnd[1]/usr/ctxtP_CTMFR'){ Quiet { (S 'wnd[1]/usr/ctxtP_CTMFR').text = '00:00:00' }; Log 'WT: time-from field present, set to 00:00:00' }
  $gotFr = ''; $gotTo = ''; $gotTm = ''
  try { $gotFr = [string](S 'wnd[1]/usr/ctxtP_CDTFR').text; $gotTo = [string](S 'wnd[1]/usr/ctxtP_CDTTO').text } catch {}
  if($gotFr.Trim().Length -lt 6 -or $gotTo.Trim().Length -lt 6){
    Log 'WT: calendar left the dates blank; typing them' 'warn'
    Quiet { (S 'wnd[1]/usr/ctxtP_CDTFR').text = (SapDate); (S 'wnd[1]/usr/ctxtP_CDTTO').text = (SapDate) }
    try { $gotFr = [string](S 'wnd[1]/usr/ctxtP_CDTFR').text; $gotTo = [string](S 'wnd[1]/usr/ctxtP_CDTTO').text } catch {}
  }
  try { $gotTm = [string](S 'wnd[1]/usr/ctxtP_CTMTO').text } catch {}
  Log "WT: window $gotFr to $gotTo up to $gotTm"
  }
  $null = Try-Step 'WT: execute' { (S 'wnd[1]/tbar[0]/btn[8]').press() }
  Sleep-Ms 1200
  if(SelectionStillOpen){
    Log ("WT: execute refused - " + (StatusMsg)) 'warn'
    SetTimeField 'wnd[1]/usr/ctxtP_CTMTO' '24:00:00' '23:59:00'
    Quiet { (S 'wnd[1]/tbar[0]/btn[8]').press() }
    Sleep-Ms 1200
    if(SelectionStillOpen){ Log ("WT: still refused - " + (StatusMsg) + "; skipping this cycle") 'error'; return $false }
    Log 'WT: accepted on the second time value'
  }
  Sleep-Ms 1800
  DismissPopups
  # Warehouse task grids carry TANUM (task number); VLTYP / VLPLA (source type
  # and bin), TOSTAT (status) and WHO (warehouse order) are also task-only.
  $taskCols = @('TANUM', 'VLTYP', 'TOSTAT', 'WHO', 'VLPLA', 'PROD_ORDER')
  $g = $null
  foreach($want in $taskCols){ $g = FindResultGrid 'STATUS_PICKING' 'FLGMOVE' $want; if($g -ne $null -and (GridHasColumn $g $want)){ Log "WT: grid identified by column $want"; break } else { $g = $null } }
  if($g -eq $null){
    $any = FindResultGrid 'STATUS_PICKING' 'FLGMOVE' ''
    if($any -ne $null){ Log ("WT: a grid is on screen but it has no warehouse task column (" + (GridColumnList $any) + "); refusing to export it as WHTask. If this IS the task list, tell me these column names.") 'error' }
    else { Log 'WT: no warehouse task grid found on screen (only the order or HU grid, or nothing); leaving the previous file alone' 'error' }
    return $false
  }
  if((GridHasColumn $g 'STATUS_PICKING') -or (GridHasColumn $g 'FLGMOVE')){ Log ("WT: that grid is the order or HU list (" + (GridColumnList $g) + "); refusing to export it as WHTask") 'error'; return $false }
  $g = EnsureWtColumns $g
  if($g -eq $null){ Log 'WT: lost the task grid after Change Layout; skipping this cycle' 'error'; return $false }
  Log ("WT: exporting grid with " + $g.RowCount + " rows, columns " + (GridColumnList $g))
  $ok = Try-Step 'WT: open export dialog' {
    $first = [string]$g.ColumnOrder.Item(0)
    $g.setCurrentCell(0, $first)
    $g.contextMenu(); $g.selectContextMenuItem('&XXL')
  }
  if(-not $ok){ return $false }
  return (ExportGridTo $WhFile (Join-Path $ReportDir $OrdersFile))
}

# ============================================================
#  Actions
# ============================================================
function AttachAndPick(){
  if(-not (Attach)){ return 2 }
  PickSession
  if($script:session -eq $null){ Emit @{ t = 'sap'; ok = 0; tcode = ''; detail = 'no SAP session (logged in?)' }; return 3 }
  try { $null = (S 'wnd[0]').Text } catch { Emit @{ t = 'sap'; ok = 0; tcode = ''; detail = 'session not ready' }; return 3 }
  Emit @{ t = 'sap'; ok = 1; tcode = (Tcode); detail = (WindowTitle) }
  return 0
}

switch($Action){
  # The handling unit export on its own. Same screen and same grid as the
  # staging pull; what changes is which bins are asked for and which file
  # it lands in, and both of those are already switches. Run it with
  # -BinPatterns 'PK*' and a -StageFile of its own and you get what is
  # standing at the pack benches, which the staging pull never sees
  # because it only ever asks for the lanes.
  'hu' {
    Phase 'attaching'
    SuppressExcelFormatWarning
    $rc = AttachAndPick
    if($rc -ne 0){ exit $rc }
    DismissPopups
    $t = GoToMonitorTree
    if($t -eq $null){ Fail 'could not reach the warehouse monitor'; exit 4 }
    $okHU = RunHU
    DismissPopups
    Phase 'done'
    Log ("handling unit pull done: " + $okHU)
    if(-not $okHU){ Fail 'the handling unit export did not succeed; see the lines above'; exit 1 }
    exit 0
  }
  'wt' {
    Phase 'attaching'
    SuppressExcelFormatWarning
    $rc = AttachAndPick
    if($rc -ne 0){ exit $rc }
    DismissPopups
    $t = GoToMonitorTree
    if($t -eq $null){ Fail 'could not reach the warehouse monitor'; exit 4 }
    $okWT = RunWhTask
    DismissPopups
    Phase 'done'
    Log ("task pull done: " + $okWT)
    if(-not $okWT){ Fail 'the warehouse task export did not succeed; see the lines above'; exit 1 }
    exit 0
  }
  'probe' {
    $rc = AttachAndPick
    exit $rc
  }
  'tree' {
    $rc = AttachAndPick
    if($rc -ne 0){ exit $rc }
    DismissPopups
    $tree = GoToMonitorTree
    if($tree -eq $null){ exit 4 }
    $nodes = @()
    try {
      $keys = $tree.GetAllNodeKeys()
      $n = 0; try { $n = $keys.Count } catch { $n = $keys.Length }
      for($i = 0; $i -lt $n; $i++){
        $k = [string]$keys.Item($i)
        $txt = ''; try { $txt = [string]$tree.GetNodeTextByKey($k) } catch {}
        $parent = ''; try { $parent = [string]$tree.GetParent($k) } catch {}
        $nodes += @{ key = $k; text = $txt; parent = $parent }
      }
    } catch { Fail ("could not read the tree: " + $_.Exception.Message); exit 1 }
    Emit @{ t = 'tree'; nodes = $nodes }
    exit 0
  }
  default {
    Phase 'attaching'
    SuppressExcelFormatWarning
    $rc = AttachAndPick
    if($rc -ne 0){ exit $rc }
    DismissPopups
    $scr = CurrentScreen
    Log ("attached: tx=" + (Tcode) + " prog=" + (Prog) + " screen=$scr")
    if($scr -ne 'REPORT'){
      $t = GoToMonitorTree
      if($t -eq $null){ Fail 'could not reach the warehouse monitor'; exit 4 }
      Sleep-Ms 2500
    }
    $okHU = RunHU
    DismissPopups
    Sleep-Ms $SwitchMs
    $okOrd = RunOrders
    DismissPopups
    Sleep-Ms $SwitchMs
    $okWT = RunWhTask
    DismissPopups
    KeepAwake
    Phase 'done'
    Log ("cycle done: HU=" + $okHU + " orders=" + $okOrd + " tasks=" + $okWT)
    if(-not ($okHU -or $okOrd -or $okWT)){ Fail 'no export succeeded this cycle'; exit 1 }
    exit 0
  }
}
