/* PaperDesk "Send to" catalog: where notes can go and the ways to get them there.
   Each destination lists its routes best-first. Route kinds:
     direct  – PaperDesk creates the items through the tool's API (conn = connector id)
     scheme  – opens the tool's app with a link that creates the item
     email   – sends an email to the tool's inbound address
     copy    – copies rich text / Markdown / lines to paste
     file    – downloads a file to import
     folder  – writes Markdown files into a folder (Chrome and Edge on desktop)
     webhook – posts the PaperDesk Send JSON (or a template) to a web address
     share   – the device's share sheet (phones, Windows, macOS Safari)
   Steps are plain text; `code` spans are written as `like this`. */
(function () {
  'use strict';

  const CATS = [
    ['notes', 'Notes apps'], ['tasks', 'Tasks & boards'], ['docs', 'Documents & sheets'], ['calendar', 'Calendars'],
    ['chat', 'Chat & phone'], ['auto', 'Automation'], ['files', 'Files'],
  ];

  const PASTE = (app) => [`Open ${app} where the notes should go.`, 'Paste with Ctrl+V (⌘V on a Mac).'];

  const D = [
    /* ---------------- Notes ---------------- */
    { id: 'onenote', name: 'OneNote', cat: 'notes', mono: 'N', color: '#7719AA', blurb: 'Pages in a notebook section',
      routes: [
        { kind: 'direct', conn: 'onenote' },
        { kind: 'email', to: 'me@onenote.com', per: 'item', steps: ['Send from the email address of your Microsoft account.', 'OneNote files each email as a page in your default notebook. Choose the notebook in OneNote\'s email settings (onenote.com/EmailSettings).'] },
        { kind: 'copy', flavor: 'html', steps: PASTE('OneNote') },
        { kind: 'file', format: 'html', steps: ['In OneNote choose Insert → File, or drag the downloaded file onto a page.'] },
      ] },
    { id: 'applenotes', name: 'Apple Notes', cat: 'notes', mono: 'AN', color: '#C9A200', blurb: 'iPhone, iPad and Mac',
      routes: [
        { kind: 'share', steps: ['Choose Notes in the share sheet.'] },
        { kind: 'copy', flavor: 'html', steps: PASTE('a note in Notes') },
        { kind: 'file', format: 'enex', steps: ['On a Mac, open Notes and choose File → Import to Notes…', 'Pick the downloaded .enex file. Notes keeps checklists and pictures.'] },
      ] },
    { id: 'keep', name: 'Google Keep', cat: 'notes', mono: 'K', color: '#D89A00', blurb: 'Quick notes and lists',
      routes: [
        { kind: 'share', steps: ['On Android choose Keep in the share sheet.'] },
        { kind: 'copy', flavor: 'text', open: 'https://keep.google.com/', steps: ['Open Google Keep and start a new note.', 'Paste with Ctrl+V. Keep has no public way for apps to add notes, so copy and paste is the route.'] },
      ] },
    { id: 'evernote', name: 'Evernote', cat: 'notes', mono: 'E', color: '#00A82D', blurb: 'Notes with checklists and files',
      routes: [
        { kind: 'file', format: 'enex', steps: ['In the Evernote desktop app choose File → Import → Evernote export files (.enex).', 'Pick the downloaded file. Checklists, tags and pictures come along.'] },
        { kind: 'email', field: true, per: 'item', steps: ['Find your personal Evernote email address in your account settings (paid plans).', 'Each note is sent as its own email; Evernote turns each one into a note.'] },
        { kind: 'copy', flavor: 'html', steps: PASTE('Evernote') },
      ] },
    { id: 'notion', name: 'Notion', cat: 'notes', mono: 'No', color: '#2F2F2F', blurb: 'Pages or database rows',
      routes: [
        { kind: 'direct', conn: 'notion' },
        { kind: 'file', format: 'mdzip', steps: ['In Notion open Settings → Import → Text & Markdown.', 'Choose the downloaded .zip. Each note becomes a page.'] },
        { kind: 'copy', flavor: 'md', steps: PASTE('a Notion page') },
      ] },
    { id: 'obsidian', name: 'Obsidian', cat: 'notes', mono: 'Ob', color: '#7C3AED', blurb: 'Markdown files in your vault',
      routes: [
        { kind: 'folder', steps: ['Choose your vault folder (or a folder inside it) once.', 'Each note becomes a Markdown file with tags and dates at the top; pictures go into an attachments folder.'] },
        { kind: 'scheme', app: 'obsidian', per: 'item', steps: ['Obsidian must be installed on this device.', 'Each note opens Obsidian once and becomes a new file.'] },
        { kind: 'file', format: 'mdzip', steps: ['Unzip the download into your vault folder.'] },
      ] },
    { id: 'logseq', name: 'Logseq', cat: 'notes', mono: 'Lq', color: '#1F5C66', blurb: 'Outliner and journal',
      routes: [
        { kind: 'copy', flavor: 'md', steps: PASTE('a Logseq page or journal') },
        { kind: 'file', format: 'opml', steps: ['In Logseq choose Settings menu → Import → OPML.', 'Pick the downloaded file.'] },
        { kind: 'folder', steps: ['Choose the pages folder of your Logseq graph once.'] },
      ] },
    { id: 'joplin', name: 'Joplin', cat: 'notes', mono: 'J', color: '#1071D3', blurb: 'Open-source notes',
      routes: [
        { kind: 'file', format: 'enex', steps: ['In Joplin choose File → Import → ENEX - Evernote Export File (as Markdown).', 'Pick the downloaded file.'] },
        { kind: 'copy', flavor: 'md', steps: PASTE('a Joplin note') },
      ] },
    { id: 'bear', name: 'Bear', cat: 'notes', mono: 'B', color: '#DA4B3E', blurb: 'Mac, iPhone and iPad',
      routes: [
        { kind: 'scheme', app: 'bear', per: 'item', steps: ['Bear must be installed on this device.', 'Each note opens Bear once and becomes a new note with its badges as tags.'] },
        { kind: 'copy', flavor: 'md', steps: PASTE('a Bear note') },
      ] },
    { id: 'drafts', name: 'Drafts', cat: 'notes', mono: 'Dr', color: '#3A6EA5', blurb: 'Capture on Apple devices',
      routes: [{ kind: 'scheme', app: 'drafts', per: 'item', steps: ['Drafts must be installed on this device.'] }, { kind: 'copy', flavor: 'md', steps: PASTE('Drafts') }] },
    { id: 'anynotes', name: 'Any other notes app', cat: 'notes', mono: '…', color: '#6B665C', blurb: 'Paste, share or import',
      routes: [
        { kind: 'copy', flavor: 'html', steps: ['Open the app where the notes should go.', 'Paste with Ctrl+V (⌘V on a Mac). Most apps keep headings, checklists and links.'] },
        { kind: 'copy', flavor: 'md', steps: ['Use this when the app understands Markdown (Craft, Bear, Typora, Notion, many developer tools).'] },
        { kind: 'share', steps: ['Pick the app in the share sheet.'] },
        { kind: 'file', format: 'mdzip', steps: ['Most apps import a folder of Markdown files. Unzip the download first if the app asks for a folder.'] },
      ] },

    /* ---------------- Tasks ---------------- */
    { id: 'mstodo', name: 'Microsoft To Do', cat: 'tasks', mono: 'TD', color: '#2564CF', blurb: 'Tasks with steps and due dates',
      routes: [{ kind: 'direct', conn: 'mstodo' }, { kind: 'copy', flavor: 'lines', steps: ['Open a list in To Do and paste into "Add a task". Each line can be added as a task.'] }] },
    { id: 'planner', name: 'Microsoft Planner', cat: 'tasks', mono: 'Pl', color: '#31752F', blurb: 'Plans in Microsoft 365 (work or school)',
      routes: [{ kind: 'direct', conn: 'planner' }, { kind: 'copy', flavor: 'text', steps: ['Open the task in Planner and paste into its description.'] }] },
    { id: 'gtasks', name: 'Google Tasks', cat: 'tasks', mono: 'GT', color: '#1A73E8', blurb: 'Tasks with sub-tasks',
      routes: [{ kind: 'direct', conn: 'gtasks' }] },
    { id: 'todoist', name: 'Todoist', cat: 'tasks', mono: 'Td', color: '#E44332', blurb: 'Tasks, sub-tasks and dates',
      routes: [
        { kind: 'direct', conn: 'todoist' },
        { kind: 'file', format: 'todoist', steps: ['In Todoist open the project menu (⋯) → Import from CSV / template.', 'Pick the downloaded file. Checklist items become sub-tasks.'] },
        { kind: 'copy', flavor: 'lines', steps: ['Paste into Todoist\'s quick add. Todoist offers to add each line as its own task.'] },
      ] },
    { id: 'things', name: 'Things 3', cat: 'tasks', mono: 'T3', color: '#3478F6', blurb: 'Mac, iPhone and iPad',
      routes: [{ kind: 'scheme', app: 'things', per: 'all', steps: ['Things must be installed on this device.', 'All notes are added at once; checklists become Things checklists.'] }] },
    { id: 'reminders', name: 'Apple Reminders', cat: 'tasks', mono: 'R', color: '#E5533D', blurb: 'iPhone, iPad and Mac',
      routes: [
        { kind: 'copy', flavor: 'lines', steps: ['Open a list in Reminders and paste. Each line becomes a reminder.'] },
        { kind: 'share', steps: ['Choose Reminders in the share sheet.'] },
      ] },
    { id: 'omnifocus', name: 'OmniFocus', cat: 'tasks', mono: 'OF', color: '#7B4FA0', blurb: 'Mac, iPhone and iPad',
      routes: [{ kind: 'scheme', app: 'omnifocus', per: 'item', steps: ['OmniFocus must be installed on this device. Each note opens OmniFocus once.'] }, { kind: 'copy', flavor: 'lines', steps: PASTE('the OmniFocus inbox') }] },
    { id: 'ticktick', name: 'TickTick', cat: 'tasks', mono: 'TT', color: '#4772FA', blurb: 'Tasks and habits',
      routes: [{ kind: 'copy', flavor: 'lines', steps: ['Paste into the "Add task" box. TickTick can add each line as a task.'] }, { kind: 'share', steps: ['On a phone, choose TickTick in the share sheet.'] }] },
    { id: 'trello', name: 'Trello', cat: 'tasks', mono: 'Tr', color: '#0C66E4', blurb: 'Cards with checklists',
      routes: [
        { kind: 'direct', conn: 'trello' },
        { kind: 'email', field: true, per: 'item', steps: ['On the board open Board menu → Settings → Email-to-board, and copy the address.', 'Each note is sent as its own email and becomes a card.'] },
        { kind: 'copy', flavor: 'lines', steps: ['Paste into "Add a card". Trello offers to make a card for each line.'] },
      ] },
    { id: 'asana', name: 'Asana', cat: 'tasks', mono: 'As', color: '#F06A6A', blurb: 'Tasks and sub-tasks',
      routes: [
        { kind: 'direct', conn: 'asana' },
        { kind: 'email', to: 'x@mail.asana.com', per: 'item', steps: ['Send from the email address you use for Asana. Each email becomes a task in My Tasks.'] },
        { kind: 'file', format: 'csv:asana', steps: ['In the project choose ⋯ → Import → CSV, and pick the downloaded file.'] },
      ] },
    { id: 'linear', name: 'Linear', cat: 'tasks', mono: 'Li', color: '#5E6AD2', blurb: 'Issues for a team',
      routes: [{ kind: 'direct', conn: 'linear' }, { kind: 'copy', flavor: 'md', steps: ['Paste into a new issue\'s description.'] }] },
    { id: 'clickup', name: 'ClickUp', cat: 'tasks', mono: 'CU', color: '#7B68EE', blurb: 'Tasks with checklists',
      routes: [{ kind: 'direct', conn: 'clickup' }, { kind: 'file', format: 'csv:clickup', steps: ['In ClickUp open Settings → Import/Export → CSV / Excel and pick the downloaded file.'] }] },
    { id: 'monday', name: 'monday.com', cat: 'tasks', mono: 'mo', color: '#FF3D57', blurb: 'Items on a board',
      routes: [{ kind: 'direct', conn: 'monday' }, { kind: 'file', format: 'csv:monday', steps: ['Create a board from Import data → Excel / CSV and pick the downloaded file.'] }] },
    { id: 'jira', name: 'Jira', cat: 'tasks', mono: 'Ji', color: '#0052CC', blurb: 'Issues in a project',
      routes: [
        { kind: 'file', format: 'csv:jira', steps: ['Use Jira\'s "Import issues from CSV" (in the issue search ⋯ menu; admins also have System → External system import).', 'Pick the downloaded file and match the columns.'] },
        { kind: 'webhook', preset: 'jira', steps: ['In Jira create an Automation rule with the trigger "Incoming webhook", add an action "Create issue" using the webhook data, and copy the webhook URL.'] },
      ] },
    { id: 'github', name: 'GitHub Issues', cat: 'tasks', mono: 'GH', color: '#24292F', blurb: 'Issues in a repository',
      routes: [{ kind: 'direct', conn: 'github' }] },
    { id: 'gitlab', name: 'GitLab Issues', cat: 'tasks', mono: 'GL', color: '#E24329', blurb: 'Issues in a project',
      routes: [{ kind: 'direct', conn: 'gitlab' }] },
    { id: 'airtable', name: 'Airtable', cat: 'tasks', mono: 'At', color: '#18BFFF', blurb: 'Rows in a table',
      routes: [{ kind: 'direct', conn: 'airtable' }, { kind: 'file', format: 'csv', steps: ['In the base choose Add or import → CSV file.'] }] },

    /* ---------------- Documents & sheets ---------------- */
    { id: 'gdocs', name: 'Google Docs', cat: 'docs', mono: 'GD', color: '#1A73E8', blurb: 'A new document in your Drive',
      routes: [{ kind: 'direct', conn: 'gdocs' }, { kind: 'copy', flavor: 'html', steps: PASTE('a Google Doc') }] },
    { id: 'word', name: 'Microsoft Word', cat: 'docs', mono: 'W', color: '#185ABD', blurb: 'A formatted document',
      routes: [{ kind: 'file', format: 'html', steps: ['Open the downloaded file with Word (right-click → Open with → Word), then save it as .docx.'] }, { kind: 'copy', flavor: 'html', steps: PASTE('a Word document') }] },
    { id: 'pdf', name: 'PDF / print', cat: 'docs', mono: 'PDF', color: '#B42318', blurb: 'Print or save as PDF',
      routes: [{ kind: 'file', format: 'pdf', steps: ['A print window opens. Choose "Save as PDF" as the printer to make a PDF.'] }] },
    { id: 'excel', name: 'Excel / Google Sheets', cat: 'docs', mono: 'XL', color: '#107C41', blurb: 'One row per note',
      routes: [{ kind: 'file', format: 'csv', steps: ['Open the downloaded .csv in Excel, Numbers or Google Sheets (File → Import).'] }, { kind: 'copy', flavor: 'tsv', steps: ['Click a cell in the sheet and paste. Each note lands on its own row.'] }] },
    { id: 'mindmap', name: 'Outliners & mind maps', cat: 'docs', mono: 'OP', color: '#0F766E', blurb: 'Workflowy, Dynalist, XMind, MindNode',
      routes: [{ kind: 'file', format: 'opml', steps: ['Use the app\'s Import → OPML option and pick the downloaded file.'] }, { kind: 'copy', flavor: 'opml', steps: ['Workflowy and Dynalist also accept the OPML text pasted straight into a list.'] }] },

    /* ---------------- Calendars ---------------- */
    { id: 'gcal', name: 'Google Calendar', cat: 'calendar', mono: 'GC', color: '#1A73E8', blurb: 'Dated notes as events',
      routes: [{ kind: 'file', format: 'ics-events', steps: ['In Google Calendar open Settings → Import & export → Import.', 'Pick the downloaded .ics file and the calendar to add it to. Only notes with a date are included.'] }] },
    { id: 'outlookcal', name: 'Outlook calendar', cat: 'calendar', mono: 'OC', color: '#0F6CBD', blurb: 'Events and to-dos',
      routes: [{ kind: 'file', format: 'ics', steps: ['Outlook on the web: Calendar → Add calendar → Upload from file.', 'Outlook for Windows/Mac: open the downloaded .ics file. Only notes with a date are included.'] }] },
    { id: 'applecal', name: 'Apple Calendar', cat: 'calendar', mono: 'AC', color: '#E5533D', blurb: 'Mac, iPhone and iPad',
      routes: [{ kind: 'file', format: 'ics-events', steps: ['Open the downloaded .ics file and choose the calendar. Only notes with a date are included.'] }] },

    /* ---------------- Chat & phone ---------------- */
    { id: 'email', name: 'Email', cat: 'chat', mono: '@', color: '#6B665C', blurb: 'Any address, your mail app',
      routes: [{ kind: 'email', field: true, per: 'all', steps: ['Your email app opens with the notes in the message.'] }, { kind: 'share', steps: ['Choose Mail in the share sheet.'] }] },
    { id: 'slack', name: 'Slack', cat: 'chat', mono: 'Sl', color: '#4A154B', blurb: 'Post to a channel',
      routes: [{ kind: 'direct', conn: 'slack' }, { kind: 'copy', flavor: 'md', steps: PASTE('the Slack message box') }] },
    { id: 'discord', name: 'Discord', cat: 'chat', mono: 'Di', color: '#5865F2', blurb: 'Post to a channel',
      routes: [{ kind: 'direct', conn: 'discord' }, { kind: 'copy', flavor: 'md', steps: PASTE('the Discord message box') }] },
    { id: 'teams', name: 'Microsoft Teams', cat: 'chat', mono: 'Te', color: '#5B5FC7', blurb: 'Post to a channel',
      routes: [{ kind: 'webhook', preset: 'teams' }, { kind: 'copy', flavor: 'html', steps: PASTE('the Teams message box') }] },
    { id: 'ntfy', name: 'Phone notification (ntfy)', cat: 'chat', mono: 'nt', color: '#317F6F', blurb: 'Push to your phone, no account',
      routes: [{ kind: 'direct', conn: 'ntfy' }] },
    { id: 'raindrop', name: 'Raindrop.io', cat: 'chat', mono: 'Rd', color: '#1988E0', blurb: 'Save link notes as bookmarks',
      routes: [{ kind: 'direct', conn: 'raindrop' }] },

    /* ---------------- Automation ---------------- */
    { id: 'zapier', name: 'Zapier', cat: 'auto', mono: 'Za', color: '#FF4F00', blurb: 'Bridge to 7,000+ apps', routes: [{ kind: 'webhook', preset: 'zapier' }] },
    { id: 'make', name: 'Make', cat: 'auto', mono: 'Mk', color: '#6D00CC', blurb: 'Visual automations', routes: [{ kind: 'webhook', preset: 'make' }] },
    { id: 'n8n', name: 'n8n', cat: 'auto', mono: 'n8', color: '#EA4B71', blurb: 'Self-hosted or cloud', routes: [{ kind: 'webhook', preset: 'n8n' }] },
    { id: 'powerautomate', name: 'Power Automate', cat: 'auto', mono: 'PA', color: '#0066FF', blurb: 'Microsoft 365 flows', routes: [{ kind: 'webhook', preset: 'powerautomate' }] },
    { id: 'ifttt', name: 'IFTTT', cat: 'auto', mono: 'If', color: '#222222', blurb: 'Applets', routes: [{ kind: 'webhook', preset: 'ifttt' }] },
    { id: 'pipedream', name: 'Pipedream', cat: 'auto', mono: 'Pd', color: '#2F2F2F', blurb: 'Workflows for developers', routes: [{ kind: 'webhook', preset: 'pipedream' }] },
    { id: 'shortcuts', name: 'Apple Shortcuts', cat: 'auto', mono: 'Sc', color: '#E1306C', blurb: 'Run a shortcut with the notes',
      routes: [{ kind: 'scheme', app: 'shortcuts', per: 'all', steps: ['Make a shortcut that takes text as input (for example "Add to Notes" or "Add Reminder").', 'Type its exact name below. The notes are passed to it as text.'] }] },

    /* ---------------- Files ---------------- */
    { id: 'f-md', name: 'Markdown file', cat: 'files', mono: 'MD', color: '#4A463F', blurb: 'One .md file', routes: [{ kind: 'file', format: 'md' }] },
    { id: 'f-mdzip', name: 'Markdown folder (.zip)', cat: 'files', mono: 'ZIP', color: '#4A463F', blurb: 'One file per note + attachments', routes: [{ kind: 'file', format: 'mdzip' }] },
    { id: 'f-html', name: 'Web page (.html)', cat: 'files', mono: 'HT', color: '#4A463F', blurb: 'Opens in any browser or Word', routes: [{ kind: 'file', format: 'html' }] },
    { id: 'f-txt', name: 'Plain text', cat: 'files', mono: 'TXT', color: '#4A463F', blurb: 'Simple .txt', routes: [{ kind: 'file', format: 'txt' }] },
    { id: 'f-csv', name: 'CSV spreadsheet', cat: 'files', mono: 'CSV', color: '#4A463F', blurb: 'Choose the columns', routes: [{ kind: 'file', format: 'csv-custom' }] },
    { id: 'f-json', name: 'JSON (PaperDesk Send)', cat: 'files', mono: '{}', color: '#4A463F', blurb: 'For developers and custom tools', routes: [{ kind: 'file', format: 'json' }] },
    { id: 'f-enex', name: 'Evernote format (.enex)', cat: 'files', mono: 'EX', color: '#4A463F', blurb: 'Evernote, Apple Notes, Joplin…', routes: [{ kind: 'file', format: 'enex' }] },
    { id: 'f-ics', name: 'Calendar (.ics)', cat: 'files', mono: 'ICS', color: '#4A463F', blurb: 'Dated notes', routes: [{ kind: 'file', format: 'ics' }] },
    { id: 'f-opml', name: 'Outline (.opml)', cat: 'files', mono: 'OP', color: '#4A463F', blurb: 'Outliners and mind maps', routes: [{ kind: 'file', format: 'opml' }] },
  ];

  /* Webhook presets: how to get the URL in each automation tool. */
  const HOOKS = {
    zapier: { name: 'Zapier', steps: ['In Zapier create a Zap with the trigger Webhooks by Zapier → Catch Hook, and copy the webhook URL.', 'Paste it below and press Send test, so Zapier learns the fields (title, text, tasks, due…).', 'Add the action for your app (Evernote, OneNote, Google Sheets, Monday, anything) and map the fields.'] },
    make: { name: 'Make', steps: ['In Make create a scenario that starts with Webhooks → Custom webhook, and copy its address.', 'Paste it below and press Send test, so Make learns the data structure.', 'Add modules for the apps you want and map the fields.'] },
    n8n: { name: 'n8n', steps: ['Add a Webhook node (method POST), copy its Production URL and activate the workflow.', 'Paste it below. In n8n, allow this site under the Webhook node\'s Options → Allowed Origins (CORS) if the test is blocked.'] },
    powerautomate: { name: 'Power Automate', steps: ['Create a flow with the trigger "When an HTTP request is received" and save it to get the URL.', 'Paste it below. Use "Generate from sample" with the JSON shown under Format, so the flow knows the fields.'] },
    ifttt: { name: 'IFTTT', steps: ['Create an applet with "Webhooks → Receive a web request with a JSON payload" and an event name, e.g. paperdesk.', 'Your URL is https://maker.ifttt.com/trigger/<event>/json/with/key/<your key> (key from the Webhooks service Documentation page).'] },
    pipedream: { name: 'Pipedream', steps: ['Create a workflow with an HTTP / Webhook trigger and copy the endpoint URL.', 'Paste it below and press Send test.'] },
    teams: { name: 'Microsoft Teams', template: 'teams', steps: ['In the channel choose ⋯ → Workflows → "Post to a channel when a webhook request is received", finish the steps and copy the URL.', 'Paste it below. Each note is posted as a card.'] },
    jira: { name: 'Jira', steps: ['Create an Automation rule with the trigger "Incoming webhook" and copy its URL.', 'Add the action "Create issue" and use {{webhookData.items}} fields (title, text) in the summary and description.'] },
    custom: { name: 'Your tool', steps: [] },
  };

  window.PDSendCatalog = { CATS, D, HOOKS };
})();
