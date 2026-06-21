# Issues detected during user testing

## Bam
No notes

## Banter
### Channel list
 * Clicking on the three dots menu on each channel gives a quick flash of an options menu but it disappears immediately
 * Channel list is the same regardless of what organization is active.
 * Are channels tied to specific groups or the org in general?

## Beacon
### Search
 * Selecting search causes the search box to quickly appear and turn black. You can refresh to briefly see it again, but something is making it disappear right away.
### Graph
 * I feel like the "repulse" feature that pushes the nodes farther away from each other is still not strong enough. In most Graph views the nodes are still mostly on top of one another. Can we rethink this view - maybe make it a 3d view that the user can navigate through spatially?

## Bond
### Settings
#### Custom Fields (Fields)
 * When the user clicks into Custom Fiends, it may briefly flash an interface for setting up custom fields but otherwise it just shows a black screen. It only flashes a meaningful interface for a brief moment

## Blank
Form builder works
### Publish
 * When a form is published, it's unclear where it would be available. We should be able to specify whether it's a public form (requiring no login), or a private form, restricted to members of an organization and/or a project. Published forms should have an optional expiration date, and a URL that can be shared for people to find.

## Book
### New Event
 * There's no way to create a calendar and without a calendar you can't create an event
 * We should be able to add attendees to an event directly from the users in the system that are accessible to the person creating the event.
 * Book needs to support Video calls through a UUID-enhanced URL so that anybody, internal or external, that has the URL can join the call. We can leverage the same video calling frameworks as Banter.
 * Events should be able to reference activities like Banter channel discussions or interactive Board sessions
 * Mark the "Booking Pages" page with a notification box that says "This feature is under development" - it's going to need to connect to Bond but for now just leave it untouched except for the notification box.

## Bench
No notes at this time.

## Brief
Home and Documents disagree on document counts.

### Home
 * Home shows 16 total documents for Mage Inc

### Documents
 * Documents shows only 4 documents.

## Bolt
### Automations
#### New Automation
 * WHEN Trigger Source only shows Bam, Banter, Beacon, Brief, Helpdesk, and Schedule as trigger events. I feel like we have a lot more events from a lot more apps. Surely there's a central place we can pull that from.
 * THEN Only shows Actions associated with Bam, Banter, Beacon, Brief, Helpdesk, and System. Again, I feel like we should be pulling this from a list of all available actions across all available apps.

## Bearing
No notes at this time

## Boards
### All Boards
 * Total Boards shows that there are 10 boards in Mage Inc
 * In the actual selector below that, it shows only 2 boards.

### Templates
 * The category tabs (All, Retro, Brainstorm, Planning, Architecture, Stragety, General) all display the same Board templates. I don't think they actually filter anything.

## MCP-Server
I'm not sure why this shows up in the Launchpad. We don't access the MCP Server as a UI App