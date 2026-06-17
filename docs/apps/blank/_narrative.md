# Blank - Forms & Surveys

Blank is BigBlueBam's form builder for creating surveys, feedback forms, registration pages, and data collection workflows with a visual drag-and-drop editor. Build a form from a palette of field types, publish it to a public URL, and review the responses that come back in a table and an analytics view, all without writing code.

## Key Features

- **Form Builder** with a drag-and-drop field palette, a live preview panel, and a per-field settings panel
- **Field Types** including short and long text, email, phone, URL, number, single and multi select, dropdown, date, time, rating, scale, NPS, checkbox, toggle, file upload, section header, paragraph, hidden fields, and page break
- **Public Form Pages** served at a shareable URL that work without authentication for external respondents, with visibility scoping to public, organization, or a specific Bam project
- **Multi-Page Forms** built with page-break dividers or per-field page numbers, with Back and Next controls and a progress bar
- **Response Viewer** with attachment-status filtering and one-click CSV export
- **Form Analytics** with total submissions, a 30-day submission trend, and a per-field breakdown (option counts for choice fields, numeric statistics for rating and scale fields)
- **Form Settings** for visibility, expiration, confirmation behavior, theming, response limits, and notification on submit
- **AI Agent Tools** that let an agent generate a form from a description, edit its fields, publish it, and summarize the responses

## Integrations

Blank form submissions emit Bolt events (`submission.created`, `form.published`, `form.closed`) that can trigger Bolt automations. With routing configured at the API level, a submission can create a Bond contact or a Helpdesk ticket. Forms can be scoped to a Bam project, and emitted events flow into the suite-wide unified activity feed.

## Getting Started

Open Blank from the Launchpad. Create a new form in the builder, add fields from the palette, configure each field in the Field Settings panel, and set visibility in the Form Settings dialog. Click Publish to get a public form URL, and share it with respondents. Review submissions in the Responses view and read aggregate trends in Analytics. You can also delegate the whole flow to an AI agent that drafts, builds, and publishes the form for you.
