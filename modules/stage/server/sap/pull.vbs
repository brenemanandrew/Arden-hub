' ============================================================
'  Staging Lane Health - SAP GUI driver (VBScript, run by cscript)
'
'  Same job as pull.ps1, in the host the old puller used: Windows Script
'  Host attaches to SAP GUI with GetObject("SAPGUI"), which works on PCs
'  where PowerShell cannot reach the running SAP session.
'
'  One invocation = one full pull cycle (HU staging, orders, warehouse
'  tasks), or /Action:probe, /Action:wt (tasks only), /Action:tree (dump the
'  monitor tree). Progress goes to stdout as JSON lines for the service.
'
'  Exit codes: 0 ok, 2 SAP GUI not reachable, 3 session not ready,
'  4 monitor tree not reachable, 1 other failure.
' ============================================================
Option Explicit

Dim named : Set named = WScript.Arguments.Named
Function Arg(n, d)
  If named.Exists(n) Then Arg = named.Item(n) Else Arg = d
End Function
Dim Action      : Action      = LCase(Arg("Action", "pull"))
Dim ReportDir   : ReportDir   = Arg("ReportDir", "C:\REPORT")
Dim StageFile   : StageFile   = Arg("StageFile", "HU STAGING.XLSX")
Dim OrdersFile  : OrdersFile  = Arg("OrdersFile", "Orders.XLSX")
Dim WhFile      : WhFile      = Arg("WhFile", "WHTask.XLSX")
' ---- the ECC side: delivery value, which EWM does not carry ----------
' These come off VL06O in ECC, not out of EWM, and they are the only
' place a dollar figure exists. The Master Shift Report has pulled them
' by hand for years; this does the same two exports on the cycle.
Dim SapDelFile  : SapDelFile  = Arg("SapDelFile", "SAP Deliveries.TXT")
Dim SapPgiFile  : SapPgiFile  = Arg("SapPgiFile", "SAP PGI.TXT")
Dim DelVariant  : DelVariant  = Arg("DelVariant", "ARDEN_OPEN_DEL")
Dim DelLayout   : DelLayout   = Arg("DelLayout", "")
Dim PgiLayout   : PgiLayout   = Arg("PgiLayout", "")
Dim Warehouse   : Warehouse   = Arg("Warehouse", "0103")
Dim Monitor     : Monitor     = Arg("Monitor", "zarden")
Dim LookbackDays: LookbackDays= CLng(Arg("LookbackDays", "3"))
Dim SettleMs    : SettleMs    = CLng(Arg("SettleMs", "4000"))
Dim SwitchMs    : SwitchMs    = CLng(Arg("SwitchMs", "6000"))
Dim DateFormat  : DateFormat  = Arg("DateFormat", "MM/dd/yyyy")
Dim HuNode      : HuNode      = Arg("HuNode", "N000000211")
Dim HuLabel     : HuLabel     = Arg("HuLabel", "")
Dim HuExpand    : HuExpand    = Arg("HuExpand", "C000000011,N000000014")
Dim HuParent    : HuParent    = Arg("HuParent", "")
Dim OrdersNode  : OrdersNode  = Arg("OrdersNode", "N000000011")
Dim OrdersLabel : OrdersLabel = Arg("OrdersLabel", "")
Dim OrdersExpand: OrdersExpand= Arg("OrdersExpand", "")
Dim OrdersParent: OrdersParent= Arg("OrdersParent", "")
Dim WtNode      : WtNode      = Arg("WtNode", "N000000275")
Dim WtLabel     : WtLabel     = Arg("WtLabel", "Warehouse Task")
Dim WtExpand    : WtExpand    = Arg("WtExpand", "N000000108")
Dim WtParent    : WtParent    = Arg("WtParent", "Documents")
' Tasks are selected by CREATION date, but a rate counts CONFIRMATIONS. A task
' created yesterday and picked this morning is only in the export if the
' window reaches back far enough, so this is how many days back it starts.
Dim WtBackDays  : WtBackDays  = CLng(Arg("WtBackDays", "3"))
' Put the task selection screen back to bare before filling in the dates.
' A filter nobody remembers typing is the reason this export came back as
' picking and nothing else for days. 0 turns it off.
Dim WtClearScreen : WtClearScreen = CLng(Arg("WtClearScreen", "1"))
' More rows than Excel will hand back inside one cycle. The node that
' carries loading tasks returns everything for the window, and four days
' of it came to 62,693 rows - the export ran past the cycle's time limit
' and was killed, so nothing was written at all. Better to say so and ask
' for a shorter window than to spend every cycle on an export that never
' lands.
Dim WtMaxRows   : WtMaxRows   = CLng(Arg("WtMaxRows", "25000"))
Dim WtToDays    : WtToDays    = CLng(Arg("WtToDays", "0"))     ' window end, days back; 0 = today
Dim Recycle     : Recycle     = CLng(Arg("Recycle", "0"))      ' 1 = open a fresh session this cycle and close the old one
Dim MemoryPopupSeen : MemoryPopupSeen = False
Dim BinPatterns : BinPatterns = Arg("BinPatterns", "e*,I*,D8*,F*,TOTE*")
Dim TmpDir      : TmpDir      = ReportDir & "\tmp"

Dim fso : Set fso = CreateObject("Scripting.FileSystemObject")
Dim sh  : Set sh  = CreateObject("WScript.Shell")
Dim application, connection, session
Set application = Nothing : Set connection = Nothing : Set session = Nothing

' ---------------- output ----------------
Function J(s)
  Dim t : t = CStr(s)
  t = Replace(t, "\", "\\")
  t = Replace(t, """", "\""")
  t = Replace(t, vbCrLf, "\n")
  t = Replace(t, vbCr, "\n")
  t = Replace(t, vbLf, "\n")
  t = Replace(t, vbTab, "\t")
  J = t
End Function
Sub Emit(line)
  On Error Resume Next
  WScript.StdOut.WriteLine line
  On Error GoTo 0
End Sub
Sub Log(msg, level)
  Emit "{""t"":""log"",""level"":""" & level & """,""msg"":""" & J(msg) & """}"
End Sub
Sub Info(msg)
  Log msg, "info"
End Sub
Sub Warn(msg)
  Log msg, "warn"
End Sub
Sub ErrLog(msg)
  Log msg, "error"
End Sub
Sub Phase(p)
  Emit "{""t"":""phase"",""phase"":""" & J(p) & """}"
End Sub
Sub Fail(msg)
  Emit "{""t"":""error"",""msg"":""" & J(msg) & """}"
End Sub
Sub EmitSap(ok, tcode, detail)
  Emit "{""t"":""sap"",""ok"":" & ok & ",""tcode"":""" & J(tcode) & """,""detail"":""" & J(detail) & """}"
End Sub
Sub SleepMs(ms)
  If ms > 0 Then WScript.Sleep ms
End Sub
Sub StepErr(what)
  If Err.Number <> 0 Then
    Warn what & " FAILED: " & Err.Number & " " & Err.Description
    Err.Clear
  End If
End Sub

' ---------------- SAP helpers ----------------
Function Attach()
  On Error Resume Next
  Dim gui
  Dim en, ed
  Set gui = GetObject("SAPGUI")
  en = Err.Number : ed = Err.Description
  If en <> 0 Then
    Dim d : d = "SAP GUI not reachable. GetObject(SAPGUI) error " & en & " " & ed & ". Is SAP Logon running in this Windows session (not as administrator)?"
    Err.Clear
    ErrLog d
    EmitSap 0, "", d
    Attach = False
    Exit Function
  End If
  Set application = gui.GetScriptingEngine
  If Err.Number <> 0 Or application Is Nothing Then
    Dim d2 : d2 = "SAP GUI found but no scripting engine: " & Err.Description & ". SAP Logon > Options > Accessibility & Scripting > Scripting > Enable scripting."
    Err.Clear
    ErrLog d2
    EmitSap 0, "", d2
    Attach = False
    Exit Function
  End If
  Info "attached via GetObject(SAPGUI)"
  Attach = True
End Function
Function Tcode()
  On Error Resume Next
  Tcode = ""
  Tcode = UCase(Trim(session.Info.Transaction & ""))
  Err.Clear
End Function
Function Prog()
  On Error Resume Next
  Prog = ""
  Prog = UCase(Trim(session.Info.Program & ""))
  Err.Clear
End Function
Function WindowTitle()
  On Error Resume Next
  WindowTitle = ""
  WindowTitle = Trim(session.findById("wnd[0]").Text & "")
  Err.Clear
End Function
Function Exists(id)
  On Error Resume Next
  Dim o
  Set o = session.findById(id)
  Exists = (Err.Number = 0) And Not (o Is Nothing)
  Err.Clear
End Function
Sub SetText(id, v)
  On Error Resume Next
  session.findById(id).text = v
  Err.Clear
End Sub
Sub Press(id)
  On Error Resume Next
  session.findById(id).press
  Err.Clear
End Sub
Sub SendKey(wnd, n)
  On Error Resume Next
  session.findById(wnd).sendVKey n
  Err.Clear
End Sub
Sub Focus(id, caret)
  On Error Resume Next
  session.findById(id).setFocus
  session.findById(id).caretPosition = caret
  Err.Clear
End Sub
Function GetText(id)
  On Error Resume Next
  GetText = ""
  GetText = Trim(session.findById(id).text & "")
  Err.Clear
End Function

' Pick the SAP window to drive: one already in the monitor, else one whose
' command field is reachable, else the first.
Sub PickSession()
  On Error Resume Next
  Dim ci, si, conn, sess, tc, best, bestConn, bestWhy, cCount, sCount
  Set best = Nothing : Set bestConn = Nothing : bestWhy = ""
  cCount = 0 : cCount = application.Children.Count
  If Err.Number <> 0 Then cCount = 1 : Err.Clear
  For ci = 0 To cCount - 1
    Set conn = Nothing : Set conn = application.Children(ci)
    If Err.Number <> 0 Then Err.Clear
    If Not conn Is Nothing Then
      sCount = 0 : sCount = conn.Children.Count
      If Err.Number <> 0 Then sCount = 1 : Err.Clear
      For si = 0 To sCount - 1
        Set sess = Nothing : Set sess = conn.Children(si)
        If Err.Number <> 0 Then Err.Clear
        If Not sess Is Nothing Then
          tc = "" : tc = UCase(Trim(sess.Info.Transaction & "")) : Err.Clear
          If InStr(tc, "MON") > 0 Then
            Set connection = conn : Set session = sess
            Info "session: using connection " & ci & " session " & si & " (already in " & tc & ")"
            Exit Sub
          End If
          If best Is Nothing Then
            Dim probe : probe = sess.findById("wnd[0]/tbar[0]/okcd").Text
            If Err.Number = 0 Then
              Set best = sess : Set bestConn = conn
              bestWhy = "connection " & ci & " session " & si & " (command field reachable, in " & tc & ")"
            End If
            Err.Clear
          End If
        End If
      Next
    End If
  Next
  If Not best Is Nothing Then
    Set session = best : Set connection = bestConn
    Info "session: using " & bestWhy
  Else
    Set connection = application.Children(0) : Set session = connection.Children(0)
    Err.Clear
    Info "session: falling back to connection 0 session 0 (" & Tcode() & ")"
  End If
End Sub

Function HasModal()
  HasModal = Exists("wnd[1]")
End Function
' The text on a popup, so the one that matters can be recognised.
Function PopupText()
  On Error Resume Next
  Dim t, u
  t = "" : t = session.findById("wnd[1]").Text : Err.Clear
  u = "" : u = session.findById("wnd[1]/usr/txtMESSTXT1").Text : Err.Clear
  If u = "" Then u = session.findById("wnd[1]/usr/txtSPOP-TEXTLINE1").Text : Err.Clear
  If u = "" Then u = session.findById("wnd[1]/usr/txtMESSTXT2").Text : Err.Clear
  PopupText = Trim(t & " " & u)
End Function
Sub DismissPopups()
  Dim i, pt
  For i = 1 To 8
    If Not HasModal() Then Exit Sub
    pt = PopupText()
    ' "No memory available" is SAP telling us this session is spent. It is
    ' noted here and the session is recycled once the cycle is over.
    If InStr(1, pt, "memory", vbTextCompare) > 0 Then
      If Not MemoryPopupSeen Then
        MemoryPopupSeen = True
        Warn "SAP reports it is out of memory (" & pt & "); a fresh session will be opened at the end of this cycle"
        Emit "{""t"":""memory"",""msg"":""" & J(pt) & """}"
      End If
    End If
    On Error Resume Next
    session.findById("wnd[1]").close
    Err.Clear
    If HasModal() Then session.findById("wnd[1]").sendVKey 0
    Err.Clear
    On Error GoTo 0
    SleepMs 300
  Next
End Sub
Sub ClearModals()
  Dim i
  For i = 1 To 4
    If Exists("wnd[2]") Then SendKey "wnd[2]", 12 : SleepMs 250
    If Exists("wnd[1]") Then SendKey "wnd[1]", 12 : SleepMs 250
    If Not Exists("wnd[1]") Then Exit Sub
  Next
End Sub
' Open a fresh session and close the one that has been doing the work.
' SAP keeps the login as long as one session stays open, so this hands back
' whatever memory the old session hoarded without anybody logging in again.
Sub RecycleSession(why)
  On Error Resume Next
  Dim before, after, tries, newSess, old
  Set old = session
  before = -1 : before = connection.Children.Count : Err.Clear
  If before < 0 Then Warn "recycle: cannot count sessions; leaving it" : Exit Sub
  If before >= 6 Then Warn "recycle: SAP already has " & before & " sessions open, so a new one cannot be opened; close some by hand" : Exit Sub
  Info "recycle: opening a fresh SAP session (" & why & ")"
  DismissPopups
  old.createSession
  If Err.Number <> 0 Then Warn "recycle: could not open a session: " & Err.Description : Err.Clear : Exit Sub
  after = before
  For tries = 1 To 30
    SleepMs 500
    after = connection.Children.Count : Err.Clear
    If after > before Then Exit For
  Next
  If after <= before Then Warn "recycle: no new session appeared after 15 s; keeping the old one" : Exit Sub
  Set newSess = Nothing : Set newSess = connection.Children(after - 1) : Err.Clear
  If newSess Is Nothing Then Warn "recycle: could not take hold of the new session; keeping the old one" : Exit Sub
  ' the new one is now the session everything else drives
  Set session = newSess
  SleepMs 800
  ' /i ends the old session. A "close?" question may appear on it; answer yes.
  old.findById("wnd[0]/tbar[0]/okcd").text = "/i" : Err.Clear
  old.findById("wnd[0]").sendVKey 0 : Err.Clear
  SleepMs 700
  old.findById("wnd[1]/usr/btnSPOP-OPTION1").press : Err.Clear
  old.findById("wnd[1]").sendVKey 0 : Err.Clear
  SleepMs 500
  MemoryPopupSeen = False
  Emit "{""t"":""recycled""}"
  Info "recycle: on a fresh session (" & Tcode() & "); the old one is closed"
End Sub
Function CurrentScreen()
  Dim tx, pg
  tx = Tcode() : pg = Prog()
  If InStr(tx, "/SCWM/MON") > 0 Or InStr(pg, "WME_MONITOR") > 0 Then
    CurrentScreen = "REPORT"
  ElseIf tx = "SESSION_MANAGER" Then
    CurrentScreen = "MAIN"
  Else
    CurrentScreen = "OTHER"
  End If
End Function
Function StatusMsg()
  On Error Resume Next
  Dim t, ty
  t = "" : ty = ""
  t = session.findById("wnd[0]/sbar").Text : Err.Clear
  ty = session.findById("wnd[0]/sbar").MessageType : Err.Clear
  If Trim(t & "") = "" Then t = session.findById("wnd[1]/sbar").Text : Err.Clear
  If Trim(t & "") = "" Then t = "(no message)"
  StatusMsg = Trim(ty & " " & t)
End Function

' Get to the /SCWM/MON tree whatever the session was doing. Returns the tree
' object or Nothing.
Function GoToMonitorTree()
  On Error Resume Next
  Dim t, i, tc
  Set GoToMonitorTree = Nothing
  DismissPopups
  tc = Tcode()
  If InStr(tc, "MON") > 0 Then
    Set t = session.findById("wnd[0]/usr/shell/shellcont[0]/shell")
    If Err.Number = 0 Then Set GoToMonitorTree = t : Exit Function
    Err.Clear
    For i = 1 To 3
      Press "wnd[0]/tbar[0]/btn[3]"
      SleepMs 500
      DismissPopups
      Set t = session.findById("wnd[0]/usr/shell/shellcont[0]/shell")
      If Err.Number = 0 Then
        Info "returned to the monitor tree after " & i & " back press(es)"
        Set GoToMonitorTree = t : Exit Function
      End If
      Err.Clear
    Next
  End If
  For i = 1 To 3
    ClearModals
    Err.Clear
    session.findById("wnd[0]/tbar[0]/okcd").text = "/n/SCWM/MON"
    If Err.Number <> 0 Then
      Warn "command field unreachable (attempt " & i & "); tcode is " & Tcode()
      Err.Clear
      SleepMs 700
    Else
      SendKey "wnd[0]", 0
      SleepMs 1200
      If Exists("wnd[1]/usr/ctxtP_LGNUM") Then
        SetText "wnd[1]/usr/ctxtP_LGNUM", Warehouse
        SetText "wnd[1]/usr/ctxtP_MONIT", Monitor
        Focus "wnd[1]/usr/txtP_REFR", 3
        Press "wnd[1]/tbar[0]/btn[8]"
        SleepMs 1200
      End If
      Set t = session.findById("wnd[0]/usr/shell/shellcont[0]/shell")
      If Err.Number = 0 Then Set GoToMonitorTree = t : Exit Function
      Err.Clear
      Warn "after attempt " & i & " the session is in " & Tcode() & " with no monitor tree"
    End If
  Next
  ErrLog "gave up reaching /SCWM/MON. Session is in " & Tcode() & " titled '" & WindowTitle() & "'. Check that this login can run /SCWM/MON and that monitor " & Monitor & " exists for warehouse " & Warehouse & "."
End Function

Function NodeText(tree, k)
  On Error Resume Next
  NodeText = ""
  NodeText = Trim(tree.GetNodeTextByKey(k) & "")
  Err.Clear
End Function
' The whole way down to a node, because two of these are the same name
' under the same parent and only the path above them says which is which.
Function NodePath(tree, k)
  On Error Resume Next
  Dim p, guard, out
  out = NodeText(tree, k)
  p = tree.GetParent(k) : Err.Clear
  guard = 0
  Do While Trim(p & "") <> "" And guard < 12
    out = NodeText(tree, p) & " > " & out
    p = tree.GetParent(p) : Err.Clear
    guard = guard + 1
  Loop
  NodePath = out
  Err.Clear
End Function
Function ParentText(tree, k)
  On Error Resume Next
  Dim pk
  ParentText = ""
  pk = tree.GetParent(k)
  If Err.Number = 0 And Trim(pk & "") <> "" Then ParentText = NodeText(tree, pk)
  Err.Clear
End Function
' Resolve a tree node by label (and parent label when the text appears more
' than once), falling back to the recorded key. Always logs what it chose.
Function ResolveNode(tree, key, label, parent)
  On Error Resume Next
  Dim chosen, how, keys, n, i, k, txt, want, exact(), starts(), ne, ns, c, under(), nu, pk, d
  chosen = key : how = "recorded key"
  If Trim(label & "") <> "" Then
    Set keys = tree.GetAllNodeKeys
    If Err.Number = 0 Then
      n = 0 : n = keys.Count : If Err.Number <> 0 Then n = keys.Length : Err.Clear
      ne = 0 : ns = 0
      ReDim exact(n) : ReDim starts(n)
      want = UCase(Trim(label))
      For i = 0 To n - 1
        k = keys.Item(i) : Err.Clear
        txt = UCase(NodeText(tree, k))
        If txt = want Then
          exact(ne) = k : ne = ne + 1
        ElseIf Left(txt, Len(want)) = want Then
          starts(ns) = k : ns = ns + 1
        End If
      Next
      ReDim cands(ne + ns)
      c = 0
      For i = 0 To ne - 1 : cands(c) = exact(i) : c = c + 1 : Next
      For i = 0 To ns - 1 : cands(c) = starts(i) : c = c + 1 : Next
      If Trim(parent & "") <> "" And c > 1 Then
        ReDim under(c) : nu = 0
        For i = 0 To c - 1
          If UCase(ParentText(tree, cands(i))) = UCase(Trim(parent)) Then under(nu) = cands(i) : nu = nu + 1
        Next
        If nu >= 1 Then
          For i = 0 To nu - 1 : cands(i) = under(i) : Next
          c = nu
        End If
      End If
      If c >= 1 Then
        chosen = cands(0)
        If c > 1 Then how = "matched by name (first of " & c & ")" Else how = "matched by name"
        ' expand the parent chain so the node is visible
        pk = tree.GetParent(chosen) : d = 0
        Do While Err.Number = 0 And Trim(pk & "") <> "" And d < 6
          tree.expandNode pk : Err.Clear
          pk = tree.GetParent(pk) : d = d + 1
        Loop
        Err.Clear
      Else
        Warn "node '" & label & "' not found by name, falling back to " & key
      End If
    Else
      Warn "node lookup by name failed: " & Err.Description & "; using " & key
      Err.Clear
    End If
  End If
  Info "node " & chosen & " = '" & NodeText(tree, chosen) & "' under '" & ParentText(tree, chosen) & "' (" & how & ")"
  ResolveNode = chosen
End Function
' Every node carrying the label, best first (parent match, then exact text,
' then prefix), with the recorded key last. The caller tries them in order
' until the screen that opens is the one it wants.
Function ResolveCandidates(tree, key, label, parent)
  On Error Resume Next
  Dim keys, n, i, k, txt, want, out(), c, tmp, j, pmatch
  ReDim out(0) : c = 0
  If Trim(label & "") <> "" Then
    Set keys = tree.GetAllNodeKeys
    If Err.Number = 0 Then
      n = 0 : n = keys.Count : If Err.Number <> 0 Then n = keys.Length : Err.Clear
      want = UCase(Trim(label))
      For i = 0 To n - 1
        k = keys.Item(i) : Err.Clear
        txt = UCase(NodeText(tree, k))
        If txt = want Or Left(txt, Len(want)) = want Then
          ReDim Preserve out(c) : out(c) = k : c = c + 1
        End If
      Next
      ' parent matches first, exact text before prefix
      For i = 0 To c - 1
        For j = i + 1 To c - 1
          If Score(tree, out(j), want, parent) > Score(tree, out(i), want, parent) Then
            tmp = out(i) : out(i) = out(j) : out(j) = tmp
          End If
        Next
      Next
    Else
      Warn "node lookup by name failed: " & Err.Description : Err.Clear
    End If
  End If
  ' The recorded key goes FIRST when there is one.
  '
  ' This tree has two nodes called 'Warehouse Task' and both sit under a
  ' parent called 'Warehouse Order' - one below Wave, one below Outbound
  ' Delivery Order. The label cannot tell them apart and neither can the
  ' parent, so they score the same and the order between them is whatever
  ' GetAllNodeKeys happened to return. The key was appended last, which
  ' meant the node somebody chose on purpose was the one tried last, and
  ' the other one opened a perfectly good task screen first - returning
  ' wave picks and no loading tasks at all.
  Dim fin(), fc
  ReDim fin(0) : fc = 0
  If Trim(key & "") <> "" Then
    ReDim Preserve fin(fc) : fin(fc) = key : fc = fc + 1
  End If
  For i = 0 To c - 1
    If out(i) <> key Then ReDim Preserve fin(fc) : fin(fc) = out(i) : fc = fc + 1
  Next
  If fc = 0 Then ReDim fin(0) : fin(0) = key
  ResolveCandidates = fin
End Function
Function Score(tree, k, want, parent)
  Score = 0
  If UCase(NodeText(tree, k)) = want Then Score = Score + 1
  If Trim(parent & "") <> "" Then
    If UCase(ParentText(tree, k)) = UCase(Trim(parent)) Then Score = Score + 2
  End If
End Function
Sub ExpandParents(tree, k)
  On Error Resume Next
  Dim pk, d
  pk = tree.GetParent(k) : d = 0
  Do While Err.Number = 0 And Trim(pk & "") <> "" And d < 6
    tree.expandNode pk : Err.Clear
    pk = tree.GetParent(pk) : d = d + 1
  Loop
  Err.Clear
End Sub
Sub ExpandList(tree, csv)
  On Error Resume Next
  Dim k
  For Each k In Split(csv, ",")
    k = Trim(k)
    If k <> "" Then tree.expandNode k : Err.Clear
  Next
End Sub

' ---- grids ----
Function GridHasColumn(g, colName)
  On Error Resume Next
  Dim cols, i, n
  GridHasColumn = False
  If Trim(colName & "") = "" Then Exit Function
  Set cols = g.ColumnOrder
  If Err.Number <> 0 Then Err.Clear : Exit Function
  n = 0 : n = cols.Count : If Err.Number <> 0 Then n = cols.Length : Err.Clear
  For i = 0 To n - 1
    If UCase(Trim(cols.Item(i) & "")) = UCase(colName) Then GridHasColumn = True : Exit Function
  Next
  Err.Clear
End Function
' A count of what is in one column, over a sample of the rows. Reading
' every row of a nine thousand row grid one cell at a time takes longer
' than the export does; a few hundred spread across it answers the only
' question being asked, which is whether a kind of row is there at all.
' Everything on a selection screen that has something in it.
'
' This pull sets a creation date and a time and nothing else, and it
' clears nothing - SAP remembers the rest per user, so a field somebody
' left filled in weeks ago is still filtering today and there is no sign
' of it anywhere. This writes the lot to the log once per cycle, so the
' question "are we filtering at all" has an answer instead of a theory.
' Empty every selection field except the ones this pull owns.
'
' SAP remembers a selection screen per user, so whatever the last person
' typed there is still narrowing the result weeks later with no sign of
' it. On the host that turned out to be a picking filter: the export came
' back as 9,090 rows that all carried a picking storage process and not
' one internal move or loading task, while the same report run with only
' a date range gives all of it.
'
' So the screen is put back to how it looks when somebody runs the report
' fresh: dates, and nothing else. The warehouse and plant fields are left
' alone - they are what makes the report this warehouse's - and so are
' checkboxes, which are usually display options rather than filters.
Function ClearSelection(rootId)
  On Error Resume Next
  Dim root, cleared, n
  cleared = "" : n = 0
  Set root = session.findById(rootId)
  If Err.Number <> 0 Then Err.Clear : ClearSelection = "" : Exit Function
  WalkClear root, cleared, n, 0
  Err.Clear
  ClearSelection = cleared
End Function
Sub WalkClear(el, ByRef cleared, ByRef n, depth)
  On Error Resume Next
  Dim kids, i, c, t, nm, kind, up
  If depth > 4 Or n > 60 Then Exit Sub
  Set kids = el.Children
  If Err.Number <> 0 Then Err.Clear : Exit Sub
  For i = 0 To kids.Count - 1
    Set c = kids.Item(i) : Err.Clear
    kind = "" : kind = c.Type : Err.Clear
    If kind = "GuiCTextField" Or kind = "GuiTextField" Then
      t = "" : t = c.Text : Err.Clear
      nm = "" : nm = c.Name : Err.Clear
      up = UCase(nm & "")
      t = Trim(t & "")
      If t <> "" _
        And InStr(up, "P_CDT") = 0 And InStr(up, "P_CTM") = 0 _
        And InStr(up, "LGNUM") = 0 And InStr(up, "WERKS") = 0 And InStr(up, "BUKRS") = 0 _
        And InStr(up, "MONITOR") = 0 Then
        c.Text = "" : Err.Clear
        If cleared <> "" Then cleared = cleared & ", "
        cleared = cleared & nm & " was " & t
        n = n + 1
      End If
    End If
    WalkClear c, cleared, n, depth + 1
  Next
  Err.Clear
End Sub
Function ScreenFilters(rootId)
  On Error Resume Next
  Dim root, out, n
  out = "" : n = 0
  Set root = session.findById(rootId)
  If Err.Number <> 0 Then Err.Clear : ScreenFilters = "" : Exit Function
  WalkFilters root, out, n, 0
  Err.Clear
  If out = "" Then
    ScreenFilters = "nothing else is filled in"
  Else
    ScreenFilters = out
  End If
End Function
Sub WalkFilters(el, ByRef out, ByRef n, depth)
  On Error Resume Next
  Dim kids, i, c, t, nm, kind
  If depth > 4 Or n > 40 Then Exit Sub
  Set kids = el.Children
  If Err.Number <> 0 Then Err.Clear : Exit Sub
  For i = 0 To kids.Count - 1
    Set c = kids.Item(i) : Err.Clear
    kind = "" : kind = c.Type : Err.Clear
    If kind = "GuiCTextField" Or kind = "GuiTextField" Or kind = "GuiComboBox" Then
      t = "" : t = c.Text : Err.Clear
      nm = "" : nm = c.Name : Err.Clear
      t = Trim(t & "")
      ' the two we set ourselves are not news
      If t <> "" And InStr(nm, "P_CDT") = 0 And InStr(nm, "P_CTM") = 0 Then
        If out <> "" Then out = out & ", "
        out = out & nm & "=" & t
        n = n + 1
      End If
    ElseIf kind = "GuiCheckBox" Then
      t = "" : t = c.Selected : Err.Clear
      nm = "" : nm = c.Name : Err.Clear
      If t = True Then
        If out <> "" Then out = out & ", "
        out = out & nm & "=on"
        n = n + 1
      End If
    End If
    WalkFilters c, out, n, depth + 1
  Next
  Err.Clear
End Sub
Function ColumnSpread(g, colName, maxRows)
  On Error Resume Next
  Dim rc, step, i, v, keys(), cnt(), k, n, found, out
  ColumnSpread = colName & ": could not be read"
  If Not GridHasColumn(g, colName) Then ColumnSpread = "no " & colName & " column in this grid" : Exit Function
  rc = 0 : rc = g.RowCount
  If Err.Number <> 0 Or rc < 1 Then Err.Clear : Exit Function
  step = 1
  If rc > maxRows Then step = Int(rc / maxRows) + 1
  n = 0
  ReDim keys(0) : ReDim cnt(0)
  For i = 0 To rc - 1 Step step
    v = "" : v = g.GetCellValue(i, colName) : Err.Clear
    v = Trim(v & "")
    If v <> "" Then
      found = -1
      For k = 0 To n - 1
        If keys(k) = v Then found = k : Exit For
      Next
      If found < 0 Then
        ReDim Preserve keys(n) : ReDim Preserve cnt(n)
        keys(n) = v : cnt(n) = 1 : n = n + 1
      Else
        cnt(found) = cnt(found) + 1
      End If
    End If
  Next
  If n = 0 Then ColumnSpread = colName & ": nothing read" : Exit Function
  out = ""
  For k = 0 To n - 1
    If out <> "" Then out = out & ", "
    out = out & keys(k) & " x" & cnt(k)
  Next
  ColumnSpread = colName & " across " & Int((rc + step - 1) / step) & " of " & rc & " rows: " & out
  Err.Clear
End Function
Function GridColumnList(g)
  On Error Resume Next
  Dim cols, i, n, out
  out = ""
  Set cols = g.ColumnOrder
  If Err.Number = 0 Then
    n = 0 : n = cols.Count : If Err.Number <> 0 Then n = cols.Length : Err.Clear
    For i = 0 To n - 1
      If i >= 14 Then out = out & ",+" & (n - 14) & " more" : Exit For
      If out <> "" Then out = out & ","
      out = out & cols.Item(i)
    Next
  End If
  Err.Clear
  If out = "" Then out = "columns unreadable"
  GridColumnList = out
End Function
' Find the result grid for the node just opened, by column, never by index.
Function FindResultGrid(avoidA, avoidB, wantCol)
  On Error Resume Next
  Dim i, cand, g, rc, fallback, fallbackPath, cands(1)
  Set FindResultGrid = Nothing : Set fallback = Nothing
  For i = 0 To 4
    cands(0) = "wnd[0]/usr/shell/shellcont[" & i & "]/shell/shellcont[0]/shell"
    cands(1) = "wnd[0]/usr/shell/shellcont[" & i & "]/shell"
    For Each cand In cands
      Err.Clear
      Set g = session.findById(cand)
      If Err.Number = 0 And Not g Is Nothing Then
        rc = 0 : rc = g.RowCount
        If Err.Number = 0 And rc > 0 Then
          If Not (GridHasColumn(g, avoidA) Or GridHasColumn(g, avoidB)) Then
            If wantCol = "" Then
              Info "grid: using " & cand & " (" & rc & " rows)"
              Set FindResultGrid = g : Exit Function
            ElseIf GridHasColumn(g, wantCol) Then
              Info "grid: using " & cand & " (" & rc & " rows, has " & wantCol & ")"
              Set FindResultGrid = g : Exit Function
            ElseIf fallback Is Nothing Then
              Set fallback = g : fallbackPath = cand
            End If
          End If
        End If
      End If
      Err.Clear
    Next
  Next
  If Not fallback Is Nothing Then
    Info "grid: using " & fallbackPath & " (no " & wantCol & " column, but not the order or HU grid)"
    Set FindResultGrid = fallback
  End If
  Err.Clear
End Function

' ---- Excel ----
Sub SuppressExcelFormatWarning()
  On Error Resume Next
  sh.RegWrite "HKCU\Software\Microsoft\Office\16.0\Excel\Security\ExtensionHardening", 0, "REG_DWORD"
  sh.RegWrite "HKCU\Software\Microsoft\Office\15.0\Excel\Security\ExtensionHardening", 0, "REG_DWORD"
  sh.RegWrite "HKCU\Software\Microsoft\Office\14.0\Excel\Security\ExtensionHardening", 0, "REG_DWORD"
  Err.Clear
End Sub
' SAP opens each export in an isolated Excel. Kill it only when it is the
' only Excel running, so nobody's open spreadsheet is ever touched.
Sub CloseExportExcel(justWrote)
  On Error Resume Next
  Dim wmi, procs, p, n, tries
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  For tries = 1 To 6
    Set procs = wmi.ExecQuery("Select * from Win32_Process Where Name='EXCEL.EXE'")
    If procs.Count >= 1 Then Exit For
    SleepMs 1000
  Next
  n = procs.Count
  If n = 1 Then
    For Each p In procs : p.Terminate : Next
    Info "close: terminated the export's Excel (only instance running)"
  ElseIf n = 0 Then
    Info "close: no Excel found to close"
  Else
    Warn "close: " & n & " Excel instances open, stood down (would hit your other files)"
  End If
  CloseExportViewer justWrote
  Err.Clear
End Sub

' A PC with no Office hands the export to whatever opens .xlsx, which on
' this one is Firefox: a window a cycle, stacking up all day on a machine
' nobody is sitting at. Only windows whose title carries the export file
' name are closed, and they are CLOSED rather than killed - a browser with
' the board open in another window keeps running, and keeps the board.
Sub CloseExportViewer(fileName)
  On Error Resume Next
  Dim sh, base, i, cmd
  If fileName = "" Then Exit Sub
  base = fileName
  i = InStrRev(base, ".")
  If i > 1 Then base = Left(base, i - 1)          ' WHTask.XLSX -> WHTask
  base = Replace(base, "'", "")
  base = Replace(base, Chr(34), "")
  If base = "" Then Exit Sub
  Set sh = CreateObject("WScript.Shell")
  cmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command " & Chr(34) & _
    "Get-Process firefox,chrome,msedge -ErrorAction SilentlyContinue | " & _
    "Where-Object { $_.MainWindowTitle -like '*" & base & "*' } | " & _
    "ForEach-Object { $null = $_.CloseMainWindow() }" & Chr(34)
  sh.Run cmd, 0, True
  Info "close: asked any browser window showing " & base & " to close"
  Err.Clear
End Sub

' ---- files ----
Sub EnsureTmpDir()
  On Error Resume Next
  If Not fso.FolderExists(ReportDir) Then fso.CreateFolder ReportDir
  If Not fso.FolderExists(TmpDir) Then fso.CreateFolder TmpDir
  Err.Clear
End Sub
Function SameSizeAs(fname, otherPath)
  On Error Resume Next
  Dim src, a, b
  SameSizeAs = False
  If Trim(otherPath & "") = "" Then Exit Function
  src = TmpDir & "\" & fname
  If fso.FileExists(src) And fso.FileExists(otherPath) Then
    a = fso.GetFile(src).Size : b = fso.GetFile(otherPath).Size
    If a > 0 And a = b Then SameSizeAs = True
  End If
  Err.Clear
End Function
Function SwapIntoPlace(fname)
  On Error Resume Next
  Dim src, dst, i
  SwapIntoPlace = False
  src = TmpDir & "\" & fname : dst = ReportDir & "\" & fname
  If Not fso.FileExists(src) Then ErrLog "EXPORT MISSING: " & src & " was not written" : Exit Function
  For i = 1 To 6
    Err.Clear
    If fso.FileExists(dst) Then fso.DeleteFile dst, True
    Err.Clear
    fso.MoveFile src, dst
    If Err.Number = 0 Then
      Emit "{""t"":""export"",""file"":""" & J(fname) & """,""bytes"":" & fso.GetFile(dst).Size & "}"
      SwapIntoPlace = True
      Exit Function
    End If
    Err.Clear
    SleepMs 700
  Next
  ErrLog "SWAP FAILED for " & fname & "; the previous copy is still in place"
End Function
' Save the current ALV grid (export menu already opened) to a named file.
' ---------------------------------------------------------------------
' The ECC side.
'
' EWM prices nothing - it is execution. The delivery value lives in ECC,
' on VL06O, and the Master Shift Report has been pulling it by hand into
' pipe-delimited text for years. This does the same two exports on the
' cycle so a board can show dollars without anybody opening Excel.
'
' It is deliberately its own action. A failure here must never cost the
' task, order or handling unit exports the board actually runs on.

' ECC is a different connection from EWM, so the session that is already
' on /SCWM/MON is the wrong one. Rather than guess at names, this tries
' each session in turn and keeps the one where VL06O actually opens.
Function PickEcc()
  On Error Resume Next
  PickEcc = False
  Dim ci, si, conn, sess, tc
  For ci = 0 To application.Children.Count - 1
    Set conn = Nothing : Set conn = application.Children(ci)
    If Not conn Is Nothing Then
      For si = 0 To conn.Children.Count - 1
        Set sess = Nothing : Set sess = conn.Children(si)
        If Not sess Is Nothing Then
          If Not sess.Busy Then
            Set session = sess : Set connection = conn
            Err.Clear
            session.findById("wnd[0]/tbar[0]/okcd").text = "/nvl06o"
            session.findById("wnd[0]").sendVKey 0
            SleepMs SwitchMs
            DismissPopups
            tc = "" : tc = Tcode() : Err.Clear
            If InStr(UCase(tc), "VL06") > 0 Then
              Info "ECC: VL06O opened on connection " & ci & " session " & si
              PickEcc = True
              Exit Function
            End If
          End If
        End If
      Next
    End If
  Next
  ErrLog "ECC: no SAP session would open VL06O. The delivery value comes from ECC, not EWM, so an ECC session has to be logged in on this PC alongside the EWM one."
  Err.Clear
End Function

' Run whatever is on the VL06O selection screen now and export the grid.
Function RunVl06Grid(fname, layout)
  On Error Resume Next
  RunVl06Grid = False
  Press "wnd[0]/tbar[1]/btn[8]"          ' execute
  SleepMs SettleMs
  DismissPopups
  Dim g : Set g = Nothing : Set g = FindGrid()
  If g Is Nothing Then
    ErrLog "ECC: nothing came back on the " & fname & " list"
    Err.Clear
    Exit Function
  End If
  If layout <> "" Then
    g.pressToolbarContextButton "&MB_VARIANT"
    g.selectContextMenuItem "&LAYOUT_CHOOSE"
    SleepMs 800
    DismissPopups
    Err.Clear
  End If
  Info "ECC: exporting " & fname & " with " & g.RowCount & " rows"
  g.pressToolbarContextButton "&MB_EXPORT"
  g.selectContextMenuItem "&PC"
  SleepMs 900
  DismissPopups
  ' the local-file dialog asks which format first on some systems
  If Exists("wnd[1]/usr/subSUBSCREEN_STEPLOOP:SAPLSPO5:0150/sub:SAPLSPO5:0150/radSPOPLI-SELFLAG[0,0]") Then
    Focus "wnd[1]/usr/subSUBSCREEN_STEPLOOP:SAPLSPO5:0150/sub:SAPLSPO5:0150/radSPOPLI-SELFLAG[0,0]", 0
    Press "wnd[1]/tbar[0]/btn[0]"
    SleepMs 700
    Err.Clear
  End If
  RunVl06Grid = ExportGridTo(fname, "")
End Function

' The open book: every delivery not yet shipped, with its value. This is
' the one a picked-value figure is built from.
Function RunSapDeliveries()
  On Error Resume Next
  RunSapDeliveries = False
  session.findById("wnd[0]/tbar[0]/okcd").text = "/nvl06o"
  session.findById("wnd[0]").sendVKey 0
  SleepMs SwitchMs
  DismissPopups
  ' the saved selection somebody already maintains, rather than filling
  ' in a selection screen this script would then own
  If DelVariant <> "" Then
    Press "wnd[0]/tbar[1]/btn[17]"        ' get variant
    SleepMs 800
    If Exists("wnd[1]/usr/txtV-LOW") Then
      session.findById("wnd[1]/usr/txtV-LOW").text = DelVariant
      session.findById("wnd[1]/usr/txtENAME-LOW").text = ""
      Press "wnd[1]/tbar[0]/btn[8]"
      SleepMs 900
      DismissPopups
    End If
    If Err.Number <> 0 Then
      Warn "ECC: could not load variant " & DelVariant & ": " & Err.Description & ". Running whatever the selection screen already has."
      Err.Clear
    End If
  End If
  RunSapDeliveries = RunVl06Grid(SapDelFile, DelLayout)
End Function

' What actually left today, with its value and the time it went. The
' Master Shift Report calls this yesterday's PGI because that is the
' window it asks for; a board wants today.
Function RunSapPgi()
  On Error Resume Next
  RunSapPgi = False
  session.findById("wnd[0]/tbar[0]/okcd").text = "/nvl06o"
  session.findById("wnd[0]").sendVKey 0
  SleepMs SwitchMs
  DismissPopups
  ' the goods-issue list rather than the open one
  Press "wnd[0]/usr/btnBUTTON_6"
  SleepMs 900
  DismissPopups
  Err.Clear
  ' actual goods issue date, today to today
  Dim d : d = SapDate(Date)
  If Exists("wnd[0]/usr/ctxtIT_WTIST-LOW") Then
    session.findById("wnd[0]/usr/ctxtIT_WTIST-LOW").text = d
    If Exists("wnd[0]/usr/ctxtIT_WTIST-HIGH") Then session.findById("wnd[0]/usr/ctxtIT_WTIST-HIGH").text = d
    Info "ECC: goods issue date " & d & " to " & d
    Err.Clear
  Else
    Warn "ECC: no actual goods issue date field on this screen; exporting whatever it is set to"
    Err.Clear
  End If
  RunSapPgi = RunVl06Grid(SapPgiFile, PgiLayout)
End Function

Function ExportGridTo(fname, rejectIfSameSizeAs)
  On Error Resume Next
  ExportGridTo = False
  SleepMs 700
  If Not Exists("wnd[1]/usr/ctxtDY_PATH") Then
    Focus "wnd[1]/usr/chkCB_ALWAYS", 0
    session.findById("wnd[1]/usr/chkCB_ALWAYS").selected = True : Err.Clear
    Press "wnd[1]/tbar[0]/btn[0]"
    SleepMs 800
  End If
  EnsureTmpDir
  Err.Clear
  session.findById("wnd[1]/usr/ctxtDY_PATH").text = TmpDir
  session.findById("wnd[1]/usr/ctxtDY_FILENAME").text = fname
  session.findById("wnd[1]/usr/ctxtDY_FILENAME").caretPosition = Len(fname)
  If Err.Number <> 0 Then
    Warn "export: path and name for " & fname & " FAILED: " & Err.Description
    Err.Clear
    DismissPopups
    Exit Function
  End If
  Press "wnd[1]/tbar[0]/btn[11]"
  SleepMs 1000
  Press "wnd[1]/usr/btnBUTTON_1"
  DismissPopups
  SleepMs SettleMs
  CloseExportExcel fname
  If SameSizeAs(fname, rejectIfSameSizeAs) Then
    ErrLog fname & " came out the same size as " & rejectIfSameSizeAs & "; that is the other report exported twice. Discarding it."
    If fso.FileExists(TmpDir & "\" & fname) Then fso.DeleteFile TmpDir & "\" & fname, True
    Err.Clear
    Exit Function
  End If
  ExportGridTo = SwapIntoPlace(fname)
End Function

Function YMD(offsetDays)
  Dim d : d = DateAdd("d", offsetDays, Date)
  YMD = Right("0000" & Year(d), 4) & Right("0" & Month(d), 2) & Right("0" & Day(d), 2)
End Function
Function HMS()
  Dim t : t = Now
  HMS = Right("0" & Hour(t), 2) & ":" & Right("0" & Minute(t), 2) & ":" & Right("0" & Second(t), 2)
End Function
Function SapDate(d)
  Dim f : f = LCase(DateFormat)
  If Left(f, 2) = "dd" Then
    SapDate = Right("0" & Day(d), 2) & Mid(DateFormat, 3, 1) & Right("0" & Month(d), 2) & Mid(DateFormat, 3, 1) & Year(d)
  ElseIf Left(f, 4) = "yyyy" Then
    SapDate = Year(d) & Mid(DateFormat, 5, 1) & Right("0" & Month(d), 2) & Mid(DateFormat, 5, 1) & Right("0" & Day(d), 2)
  Else
    SapDate = Right("0" & Month(d), 2) & "/" & Right("0" & Day(d), 2) & "/" & Year(d)
  End If
End Function
Sub SetTimeField(fieldId, firstTry, fallback)
  Dim got
  SetText fieldId, firstTry
  Focus fieldId, 2
  got = GetText(fieldId)
  If got <> firstTry Then
    SetText fieldId, fallback
    got = GetText(fieldId)
    Warn "WT: time field would not take " & firstTry & "; now reads '" & got & "'"
  End If
End Sub
Sub CloseCalendar(which)
  If Exists("wnd[2]") Then
    Info "WT: calendar still open after date " & which & "; closing it"
    Press "wnd[2]/tbar[0]/btn[0]"
    If Exists("wnd[2]") Then SendKey "wnd[2]", 0
  End If
End Sub
Function SelectionStillOpen()
  SelectionStillOpen = Exists("wnd[1]/usr/ctxtP_CDTFR")
End Function
Sub KeepAwake()
  SetText "wnd[0]/tbar[0]/okcd", ""
  SendKey "wnd[0]", 0
End Sub
Sub PickCalendarDate(fieldId, ymd)
  Focus fieldId, 0
  SendKey "wnd[1]", 4
  SleepMs 400
  On Error Resume Next
  session.findById("wnd[2]/usr/cntlCONTAINER/shellcont/shell").focusDate = ymd
  session.findById("wnd[2]/usr/cntlCONTAINER/shellcont/shell").selectionInterval = ymd & "," & ymd
  Err.Clear
End Sub

' ============================================================
'  The three pulls
' ============================================================
Function RunHU()
  On Error Resume Next
  Dim tree, node, pats, i, base, id, g
  RunHU = False
  Phase "HU staging"
  Set tree = GoToMonitorTree()
  If tree Is Nothing Then ErrLog "HU: could not reach the monitor tree; skipping" : Exit Function
  session.findById("wnd[0]").resizeWorkingPane 211, 28, False : Err.Clear
  ExpandList tree, HuExpand
  node = ResolveNode(tree, HuNode, HuLabel, HuParent)
  Err.Clear
  tree.selectedNode = node
  tree.topNode = "C000000001" : Err.Clear
  tree.doubleClickNode node
  If Err.Number <> 0 Then Warn "HU: open handling unit node FAILED: " & Err.Description : Err.Clear : Exit Function
  SleepMs 800
  Press "wnd[1]/usr/btn%_S_LGPLA_%_APP_%-VALU_PUSH"
  If Exists("wnd[2]/usr/tabsTAB_STRIP/tabpSIVA/ssubSCREEN_HEADER:SAPLALDB:3010/tblSAPLALDBSINGLE/ctxtRSCSEL_255-SLOW_I[1,0]") Then
    pats = Split(BinPatterns, ",")
    base = "wnd[2]/usr/tabsTAB_STRIP/tabpSIVA/ssubSCREEN_HEADER:SAPLALDB:3010/tblSAPLALDBSINGLE/ctxtRSCSEL_255-SLOW_I[1,"
    For i = 0 To UBound(pats)
      id = base & i & "]"
      SetText id, Trim(pats(i))
    Next
    Focus base & UBound(pats) & "]", Len(Trim(pats(UBound(pats))))
    Press "wnd[2]/tbar[0]/btn[8]"
  Else
    Warn "HU: bin multi-selection did not open; running with the node defaults"
  End If
  Press "wnd[1]/tbar[0]/btn[8]"
  SleepMs 1500
  DismissPopups
  Set g = FindResultGrid("STATUS_PICKING", "", "FLGMOVE")
  If g Is Nothing Then ErrLog "HU: no handling unit grid on screen; leaving the previous file alone" : Exit Function
  Err.Clear
  g.setCurrentCell 5, "FLGMOVE"
  g.contextMenu
  g.selectContextMenuItem "&XXL"
  If Err.Number <> 0 Then Warn "HU: open export menu FAILED: " & Err.Description : Err.Clear : Exit Function
  RunHU = ExportGridTo(StageFile, "")
End Function

Function RunOrders()
  On Error Resume Next
  Dim tree, node, g, gotFr, gotTo
  RunOrders = False
  Phase "orders"
  Set tree = GoToMonitorTree()
  If tree Is Nothing Then ErrLog "Orders: could not reach the monitor tree; skipping" : Exit Function
  session.findById("wnd[0]").resizeWorkingPane 211, 28, False : Err.Clear
  ExpandList tree, OrdersExpand
  node = ResolveNode(tree, OrdersNode, OrdersLabel, OrdersParent)
  Err.Clear
  tree.selectedNode = node
  tree.doubleClickNode node
  If Err.Number <> 0 Then Warn "Orders: open order node FAILED: " & Err.Description : Err.Clear : Exit Function
  SleepMs 1000
  SetText "wnd[1]/usr/ctxtS_DERI-LOW", "1"
  SetText "wnd[1]/usr/ctxtS_DERI-HIGH", "9"
  SetText "wnd[1]/usr/ctxtS_DGII-LOW", "0"
  SetText "wnd[1]/usr/ctxtS_DGII-HIGH", "1"
  PickCalendarDate "wnd[1]/usr/ctxtP_CDATFR", YMD(-LookbackDays)
  CloseCalendar "from"
  PickCalendarDate "wnd[1]/usr/ctxtP_CDATTO", YMD(0)
  CloseCalendar "to"
  SetText "wnd[1]/usr/ctxtP_CTIMTO", HMS()
  gotFr = GetText("wnd[1]/usr/ctxtP_CDATFR") : gotTo = GetText("wnd[1]/usr/ctxtP_CDATTO")
  If Len(gotFr) < 6 Or Len(gotTo) < 6 Then
    Warn "Orders: calendar left the dates blank; typing them"
    SetText "wnd[1]/usr/ctxtP_CDATFR", SapDate(DateAdd("d", -LookbackDays, Date))
    SetText "wnd[1]/usr/ctxtP_CDATTO", SapDate(Date)
    gotFr = GetText("wnd[1]/usr/ctxtP_CDATFR") : gotTo = GetText("wnd[1]/usr/ctxtP_CDATTO")
  End If
  Info "Orders: window " & gotFr & " to " & gotTo
  Press "wnd[1]/tbar[0]/btn[8]"
  SleepMs 1500
  DismissPopups
  Set g = FindResultGrid("FLGMOVE", "", "STATUS_PICKING")
  If g Is Nothing Then ErrLog "Orders: no order grid on screen; leaving the previous file alone" : Exit Function
  Err.Clear
  g.setCurrentCell 5, "STATUS_PICKING"
  g.contextMenu
  g.selectContextMenuItem "&XXL"
  If Err.Number <> 0 Then Warn "Orders: open export menu FAILED: " & Err.Description : Err.Clear : Exit Function
  RunOrders = ExportGridTo(OrdersFile, "")
End Function

Function RunWhTask()
  On Error Resume Next
  Dim tree, node, g, today, gotFr, gotTo, gotTm, taskCols, want, first
  RunWhTask = False
  Phase "warehouse tasks"
  Set tree = GoToMonitorTree()
  If tree Is Nothing Then ErrLog "WT: could not get back to the monitor tree; skipping" : Exit Function
  session.findById("wnd[0]").resizeWorkingPane 211, 28, False : Err.Clear
  ExpandList tree, WtExpand
  ' Several nodes carry the name "Warehouse Task" and each opens a different
  ' selection screen. Try them best-first until the creation-date screen
  ' (the one this pull fills in) is the one on screen.
  Dim cands, ci, opened, title, noDates
  cands = ResolveCandidates(tree, WtNode, WtLabel, WtParent)
  opened = False
  noDates = False
  For ci = 0 To UBound(cands)
    node = cands(ci)
    Err.Clear
    ExpandParents tree, node
    tree.selectedNode = node
    tree.topNode = "C000000001" : Err.Clear
    tree.doubleClickNode node
    If Err.Number <> 0 Then
      Warn "WT: open node " & node & " ('" & NodeText(tree, node) & "') FAILED: " & Err.Description
      Err.Clear
    Else
      SleepMs 1400
      If Exists("wnd[1]/usr/ctxtP_CDTFR") Then
        Info "WT: node " & node & " opened the task selection screen - " & NodePath(tree, node)
        opened = True
        Exit For
      End If
      title = GetText("wnd[1]")
      ' A node somebody chose on purpose is used even when its selection
      ' screen is a different one. It was chosen because its report is the
      ' right report - refusing it here means silently falling back to the
      ' node they were trying to get away from, and the only sign is a thin
      ' board nobody can explain.
      If Len(WtNode) > 0 And node = WtNode Then
        Warn "WT: node " & node & " = '" & NodeText(tree, node) & "' opened '" & title & "', which has no creation-date field. Using it anyway because it is the one configured in Settings; the date window will not be applied, so this report returns whatever it defaults to."
        opened = True
        noDates = True
        Exit For
      End If
      Warn "WT: node " & node & " = '" & NodeText(tree, node) & "' under '" & ParentText(tree, node) & "' opened '" & title & "', not the task screen; trying the next one"
      DismissPopups
      Set tree = GoToMonitorTree()
      If tree Is Nothing Then ErrLog "WT: lost the monitor tree while trying nodes" : Exit Function
    End If
  Next
  If Not opened Then
    ' Name what was actually tried. Saying "none of the 2 'Warehouse Task'
    ' nodes" when both of them were called 'Outbound Delivery Order Item'
    ' sends somebody looking for the wrong thing.
    Dim tried, ti
    tried = ""
    For ti = 0 To UBound(cands)
      If tried <> "" Then tried = tried & ", "
      tried = tried & "'" & NodeText(tree, cands(ti)) & "' (" & cands(ti) & ")"
    Next
    ErrLog "WT: no task export this cycle. Tried " & (UBound(cands) + 1) & " node(s): " & tried & ". None of them opened a task selection screen. The task node in Settings should be a node actually named Warehouse Task - on this monitor the one that works sits under Outbound Delivery Order > Warehouse Order. Admin > Monitor tree has a 'use for tasks' button on each of them."
    Exit Function
  End If
  If WtClearScreen <> 0 Then
    Dim wiped
    wiped = ClearSelection("wnd[1]/usr")
    If wiped <> "" Then Info "WT: cleared what was left on the selection screen: " & wiped
  End If
  If noDates Then
    Info "WT: this screen has no creation-date fields, so nothing is being restricted - the report runs as it stands, the way it does when a person runs it by hand"
  Else
  today = YMD(-WtToDays)
  PickCalendarDate "wnd[1]/usr/ctxtP_CDTFR", YMD(-WtBackDays)
  CloseCalendar "from"
  PickCalendarDate "wnd[1]/usr/ctxtP_CDTTO", today
  CloseCalendar "to"
  SetTimeField "wnd[1]/usr/ctxtP_CTMTO", "23:59:59", "24:00:00"
  If Exists("wnd[1]/usr/ctxtP_CTMFR") Then SetText "wnd[1]/usr/ctxtP_CTMFR", "00:00:00" : Info "WT: time-from field present, set to 00:00:00"
  gotFr = GetText("wnd[1]/usr/ctxtP_CDTFR") : gotTo = GetText("wnd[1]/usr/ctxtP_CDTTO")
  If Len(gotFr) < 6 Or Len(gotTo) < 6 Then
    Warn "WT: calendar left the dates blank; typing them"
    SetText "wnd[1]/usr/ctxtP_CDTFR", SapDate(DateAdd("d", -WtBackDays, Date))
    SetText "wnd[1]/usr/ctxtP_CDTTO", SapDate(DateAdd("d", -WtToDays, Date))
    gotFr = GetText("wnd[1]/usr/ctxtP_CDTFR") : gotTo = GetText("wnd[1]/usr/ctxtP_CDTTO")
  End If
  gotTm = GetText("wnd[1]/usr/ctxtP_CTMTO")
  Info "WT: window " & gotFr & " to " & gotTo & " up to " & gotTm & " (creation dates, " & WtBackDays & " to " & WtToDays & " day(s) back)"
  End If
  Info "WT: selection screen, besides the dates: " & ScreenFilters("wnd[1]/usr")
  Press "wnd[1]/tbar[0]/btn[8]"
  SleepMs 1200
  If SelectionStillOpen() Then
    Warn "WT: execute refused - " & StatusMsg()
    SetTimeField "wnd[1]/usr/ctxtP_CTMTO", "24:00:00", "23:59:00"
    Press "wnd[1]/tbar[0]/btn[8]"
    SleepMs 1200
    If SelectionStillOpen() Then ErrLog "WT: still refused - " & StatusMsg() & "; skipping this cycle" : Exit Function
    Info "WT: accepted on the second time value"
  End If
  SleepMs 1800
  DismissPopups
  ' Warehouse task grids carry TANUM (task number); VLTYP / VLPLA (source type
  ' and bin), TOSTAT (status) and WHO (warehouse order) are also task-only.
  taskCols = Array("TANUM", "VLTYP", "TOSTAT", "WHO", "VLPLA", "PROD_ORDER")
  Set g = Nothing
  For Each want In taskCols
    Set g = FindResultGrid("STATUS_PICKING", "FLGMOVE", want)
    If Not g Is Nothing Then
      If GridHasColumn(g, want) Then Info "WT: grid identified by column " & want : Exit For
      Set g = Nothing
    End If
  Next
  If g Is Nothing Then
    Dim anyg : Set anyg = FindResultGrid("STATUS_PICKING", "FLGMOVE", "")
    If Not anyg Is Nothing Then
      ErrLog "WT: a grid is on screen but it has no warehouse task column (" & GridColumnList(anyg) & "); refusing to export it as WHTask. If this IS the task list, send these column names."
    Else
      ErrLog "WT: no warehouse task grid found on screen (only the order or HU grid, or nothing); leaving the previous file alone"
    End If
    Exit Function
  End If
  If GridHasColumn(g, "STATUS_PICKING") Or GridHasColumn(g, "FLGMOVE") Then
    ErrLog "WT: that grid is the order or HU list (" & GridColumnList(g) & "); refusing to export it as WHTask"
    Exit Function
  End If
  Dim wtRows
  wtRows = 0 : wtRows = g.RowCount : Err.Clear
  ' Only worth refusing while there is still something to narrow. At a
  ' single day there is nowhere left to go, so export it and let the
  ' cycle's own time limit be the judge - a long export that might finish
  ' beats one that is never attempted.
  If WtMaxRows > 0 And wtRows > WtMaxRows And WtBackDays > 0 Then
    Emit "{""t"":""wtbig"",""rows"":" & wtRows & ",""max"":" & WtMaxRows & ",""days"":" & WtBackDays & "}"
    ErrLog "WT: this window came back with " & wtRows & " rows, past the " & WtMaxRows & " this cycle can export in time. Asking for a shorter window next time instead of exporting one that gets killed half way."
    Exit Function
  End If
  If WtMaxRows > 0 And wtRows > WtMaxRows Then
    Warn "WT: " & wtRows & " rows is past the " & WtMaxRows & " this cycle is meant to handle, but the window is already down to a single day so there is nothing left to narrow. Exporting it anyway; raise the cycle time limit in Settings if it gets killed."
    Emit "{""t"":""wtbig"",""rows"":" & wtRows & ",""max"":" & WtMaxRows & ",""days"":0,""exporting"":1}"
  End If
  ' What a window of this width actually cost. The puller narrows itself
  ' when an export is too big and had no way back up, so a floor that got
  ' quieter stayed on a one day window for ever and understated every
  ' picker. This is how it learns there is room again.
  Emit "{""t"":""wtok"",""rows"":" & wtRows & ",""max"":" & WtMaxRows & ",""days"":" & WtBackDays & "}"
  Info "WT: exporting grid with " & wtRows & " rows, columns " & GridColumnList(g)
  ' The process-type sample that used to be here read one value out of
  ' 400 tries: an ALV grid only hands back the rows it has already
  ' loaded, so sampling a long grid samples the first screenful. The
  ' export itself answers the same question a minute later.
  Err.Clear
  first = g.ColumnOrder.Item(0)
  g.setCurrentCell 0, first
  g.contextMenu
  g.selectContextMenuItem "&XXL"
  If Err.Number <> 0 Then Warn "WT: open export dialog FAILED: " & Err.Description : Err.Clear : Exit Function
  RunWhTask = ExportGridTo(WhFile, ReportDir & "\" & OrdersFile)
End Function

' ============================================================
'  Actions
' ============================================================
Function AttachAndPick()
  On Error Resume Next
  AttachAndPick = 0
  If Not Attach() Then AttachAndPick = 2 : Exit Function
  PickSession
  If session Is Nothing Then EmitSap 0, "", "no SAP session (logged in?)" : AttachAndPick = 3 : Exit Function
  Dim probe : probe = session.findById("wnd[0]").Text
  If Err.Number <> 0 Then Err.Clear : EmitSap 0, "", "session not ready" : AttachAndPick = 3 : Exit Function
  EmitSap 1, Tcode(), WindowTitle()
End Function

Dim rc, tree, keys, n, i, k, txt, pk, nodes, okHU, okOrd, okWT, scr, t
Select Case Action
  Case "probe"
    rc = AttachAndPick()
    WScript.Quit rc
  Case "tree"
    rc = AttachAndPick()
    If rc <> 0 Then WScript.Quit rc
    DismissPopups
    Set tree = GoToMonitorTree()
    If tree Is Nothing Then WScript.Quit 4
    On Error Resume Next
    nodes = ""
    Set keys = tree.GetAllNodeKeys
    If Err.Number <> 0 Then Fail "could not read the tree: " & Err.Description : WScript.Quit 1
    n = 0 : n = keys.Count : If Err.Number <> 0 Then n = keys.Length : Err.Clear
    For i = 0 To n - 1
      k = keys.Item(i) : Err.Clear
      txt = NodeText(tree, k)
      pk = "" : pk = tree.GetParent(k) : Err.Clear
      If nodes <> "" Then nodes = nodes & ","
      nodes = nodes & "{""key"":""" & J(k) & """,""text"":""" & J(txt) & """,""parent"":""" & J(pk) & """}"
    Next
    Emit "{""t"":""tree"",""nodes"":[" & nodes & "]}"
    WScript.Quit 0
  Case "del"
    ' The ECC side, on its own so a bad day here costs the board nothing.
    Phase "attaching"
    SuppressExcelFormatWarning
    If Not Attach() Then WScript.Quit 2
    If Not PickEcc() Then WScript.Quit 4
    Dim okDel, okPgi
    okDel = RunSapDeliveries()
    DismissPopups
    okPgi = RunSapPgi()
    DismissPopups
    Phase "done"
    Emit "{""t"":""del"",""deliveries"":" & LCase(CStr(okDel)) & ",""pgi"":" & LCase(CStr(okPgi)) & "}"
    Info "ECC: deliveries=" & okDel & " pgi=" & okPgi
    If okDel Or okPgi Then WScript.Quit 0 Else WScript.Quit 1
  Case "wt"
    Phase "attaching"
    SuppressExcelFormatWarning
    rc = AttachAndPick()
    If rc <> 0 Then WScript.Quit rc
    DismissPopups
    Set t = GoToMonitorTree()
    If t Is Nothing Then Fail "could not reach the warehouse monitor" : WScript.Quit 4
    okWT = RunWhTask()
    DismissPopups
    Phase "done"
    Info "task pull done: " & okWT
    If Not okWT Then Fail "the warehouse task export did not succeed; see the lines above" : WScript.Quit 1
    WScript.Quit 0
  ' The handling unit export on its own. Same screen, same grid - what
  ' changes is which bins are asked for and which file it lands in, both
  ' of which are already switches. Run it with /BinPatterns:PK* and a
  ' /StageFile of its own and the answer is what is standing at the pack
  ' benches, which the staging pull never sees because it only ever asks
  ' for the lanes.
  Case "hu"
    Phase "attaching"
    SuppressExcelFormatWarning
    rc = AttachAndPick()
    If rc <> 0 Then WScript.Quit rc
    DismissPopups
    Set t = GoToMonitorTree()
    If t Is Nothing Then Fail "could not reach the warehouse monitor" : WScript.Quit 4
    okHU = RunHU()
    DismissPopups
    Phase "done"
    Info "handling unit pull done: " & okHU
    If Not okHU Then Fail "the handling unit export did not succeed; see the lines above" : WScript.Quit 1
    WScript.Quit 0
  Case Else
    Phase "attaching"
    SuppressExcelFormatWarning
    rc = AttachAndPick()
    If rc <> 0 Then WScript.Quit rc
    DismissPopups
    If Recycle <> 0 Then RecycleSession "scheduled refresh"
    scr = CurrentScreen()
    Info "attached: tx=" & Tcode() & " prog=" & Prog() & " screen=" & scr
    If scr <> "REPORT" Then
      Set t = GoToMonitorTree()
      If t Is Nothing Then Fail "could not reach the warehouse monitor" : WScript.Quit 4
      SleepMs 2500
    End If
    okHU = RunHU()
    DismissPopups
    SleepMs SwitchMs
    okOrd = RunOrders()
    DismissPopups
    SleepMs SwitchMs
    okWT = RunWhTask()
    DismissPopups
    If MemoryPopupSeen Then RecycleSession "SAP reported no memory available"
    KeepAwake
    Phase "done"
    Info "cycle done: HU=" & okHU & " orders=" & okOrd & " tasks=" & okWT
    If Not (okHU Or okOrd Or okWT) Then Fail "no export succeeded this cycle" : WScript.Quit 1
    WScript.Quit 0
End Select
