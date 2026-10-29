# ============================================================
#  Staging Lane Health - press the button a person would press
#
#  Restarting SAP goes through the Okta tile, which normally hands back a
#  SAP GUI shortcut on its own. Sometimes it stops one click short: the
#  session is good, the page is right, and a Sign in button sits there
#  waiting for somebody. On a night shift nobody is there, so the whole
#  recovery stalls on one click.
#
#  How it gets at that button. Edge and Chrome do not hand the contents of
#  a page to UI Automation unless something they trust as assistive
#  technology is running, so walking the window's tree finds the browser's
#  own toolbar and nothing from the page. The one part of the page they do
#  expose is whatever has the keyboard focus - and on a page that is
#  waiting for a click, that is the very thing it is waiting on. So this
#  brings the window to the front, reads the focused control, and presses
#  it. Firefox publishes the whole page, so that is searched too.
#
#  What it will not do:
#    - it will not type anything into anything. No field is filled in, so
#      no password is ever entered here, which is the promise the rest of
#      the recovery makes. The one key it will send is Enter, and only
#      into a text box in a window titled like the page it just opened -
#      which is what pressing Enter in a sign-in form means.
#    - it will not press a control it was not told to look for. Only names
#      matching -Names are pressed.
#    - it will not touch a window that is not the browser it opened. The
#      window has to match -TitleHint and be the one in front.
#
#  Every control it could see is printed, whether or not it pressed one,
#  so the pull log shows what the page offered on the night it did not
#  work.
#
#  Exit codes: 0 pressed something, 3 nothing to press, 2 no browser
#  window found, 1 something went wrong.
# ============================================================
param(
  [string]$Names = 'sign in,log in,log on,signin,continue,launch',
  [string]$Processes = 'msedge,chrome,firefox,brave,opera',
  [string]$TitleHint = 'okta',
  [int]$WaitSec = 25,
  [switch]$NoKeys
)

$ErrorActionPreference = 'Continue'
try{
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
}catch{
  Write-Output "no UI automation on this PC: $($_.Exception.Message)"
  exit 1
}
if(-not ('Slh.Fg' -as [type])){
  Add-Type -Name Fg -Namespace Slh -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
'@ | Out-Null
}

$wanted = @($Names.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
$procNames = @($Processes.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
$hint = $TitleHint.Trim().ToLower()

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$seen = New-Object System.Collections.Generic.HashSet[string]

function Short($s){
  $t = ([string]$s).Trim()
  if($t.Length -gt 60){ return $t.Substring(0, 60) }
  return $t
}
function Matches-Wanted($name){
  $low = ([string]$name).Trim().ToLower()
  if(-not $low){ return $false }
  foreach($n in $wanted){ if($low -eq $n -or $low.Contains($n)){ return $true } }
  return $false
}
function Browser-Windows {
  $out = @()
  try{
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Window)
    foreach($w in $AE::RootElement.FindAll($TS::Children, $cond)){
      try{
        # not $pid: PowerShell owns that name, and assigning to it throws -
        # which quietly skipped every window this was meant to find
        $procId = $w.Current.ProcessId
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if(-not $p){ continue }
        if($procNames -notcontains $p.ProcessName.ToLower()){ continue }
        $out += [pscustomobject]@{ El = $w; Title = [string]$w.Current.Name; Proc = $p.ProcessName;
                                   Hwnd = [IntPtr]$w.Current.NativeWindowHandle }
      }catch{}
    }
  }catch{}
  $pref = @($out | Where-Object { $hint -and $_.Title.ToLower().Contains($hint) })
  $rest = @($out | Where-Object { -not ($hint -and $_.Title.ToLower().Contains($hint)) })
  return @($pref + $rest)
}
function Press($el){
  try{
    $p = $null
    if($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)){ $p.Invoke(); return $true }
    if($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$p)){ $p.DoDefaultAction(); return $true }
  }catch{}
  return $false
}
function Front($w){
  try{
    [void][Slh.Fg]::ShowWindow($w.Hwnd, 9)        # restore it if it was minimised
    [void][Slh.Fg]::SetForegroundWindow($w.Hwnd)
    Start-Sleep -Milliseconds 600
    return ([Slh.Fg]::GetForegroundWindow() -eq $w.Hwnd)
  }catch{ return $false }
}

$deadline = (Get-Date).AddSeconds([Math]::Max(3, $WaitSec))
$sawWindow = $false

while((Get-Date) -lt $deadline){
  $wins = Browser-Windows
  $first = $true
  foreach($w in $wins){
    # inside the loop, not on a .Count of the result: a single window comes
    # back from the function unrolled, and the count of that was never read
    $sawWindow = $true

    # ---- 1. whatever the page has put the focus on ----------------------
    #  Only for the window in front, because the focused element is the
    #  whole machine's, not this window's: pressing it without checking
    #  could press something in whatever else was on screen.
    #  and only for the window this is most likely to have opened, so a
    #  second browser window is never yanked in front of somebody
    $mine = $first -or ($hint -and $w.Title.ToLower().Contains($hint))
    $first = $false
    if($mine){
      #  Windows does not always let a background program put a window in
      #  front, and when it refuses, the focused control is still readable.
      #  So do not hang the whole thing on that: press what has the focus
      #  as long as it belongs to this browser window's own process.
      $isFront = Front $w
      $f = $null
      try{ $f = $AE::FocusedElement }catch{}
      try{ if($f -and $f.Current.ProcessId -ne $w.El.Current.ProcessId){ $f = $null } }catch{ $f = $null }
      if($f){
        $name = ''; $kind = ''
        try{ $name = Short $f.Current.Name }catch{}
        try{ $kind = $f.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' }catch{}
        if($name){ [void]$seen.Add("$kind '$name' (has the focus)") }
        if(Matches-Wanted $name){
          if(Press $f){ Write-Output "pressed '$name' in $($w.Proc) ($($w.Title))"; exit 0 }
        }
        # a form with the cursor in a box is a form that Enter submits,
        # which is the other thing a person does on a page like this
        if(-not $NoKeys -and $isFront -and $hint -and $w.Title.ToLower().Contains($hint) -and ($kind -eq 'Edit' -or $kind -eq 'ComboBox')){
          try{
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Write-Output "pressed Enter in the $kind on $($w.Title)"
            exit 0
          }catch{ Write-Output "could not press Enter: $($_.Exception.Message)" }
        }
      }
    }

    # ---- 2. the page itself, where the browser publishes it -------------
    try{
      $btn  = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
      $link = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Hyperlink)
      $cond = New-Object System.Windows.Automation.OrCondition($btn, $link)
      foreach($el in $w.El.FindAll($TS::Descendants, $cond)){
        $name = ''
        try{ $name = Short $el.Current.Name }catch{}
        if(-not $name){ continue }
        [void]$seen.Add($name)
        if(-not (Matches-Wanted $name)){ continue }
        try{ if($el.Current.IsOffscreen){ continue } }catch{}
        if(Press $el){ Write-Output "pressed '$name' in $($w.Proc) ($($w.Title))"; exit 0 }
      }
    }catch{}
  }
  Start-Sleep -Milliseconds 1500
}

if($seen.Count){
  $list = @($seen) | Select-Object -First 14
  Write-Output ("what the window offered: " + ($list -join ' | '))
}
if(-not $sawWindow){ Write-Output 'no browser window was open to press anything in'; exit 2 }
Write-Output 'nothing on the page matched the names to press'
exit 3
