# **BigBlueBam ToDo**

Study the history and current status of the project, specifically around development principles and practices. There’s a lot of documentation \- it should explain anything you need to know. Below is a set of requirements to meet or features to implement. Work through each one in order, launching agent swarms to address each one.

You will need to operate largely unattended. Do not stop working to ask questions \- use your best judgement, document your decisions, and present them for human review as you finish.

Rebuild local Docker images as needed to test in simulated production. Run unit tests and smoke tests as you wrap up each requirement. When something fails, track down the source. If you find a bug while working, add the bug to the list of tasks and solve it: we do not leave known bugs in the software just because they were “pre-existing”.

Some of these might have already been fixed or implemented, but are presented here for you to check and remediate if not:

* In Banter, there is a 3-dots menu on the right for any message posted by a user. Clicking on those flashes a menu VERY quickly with Edit, Delete, Bookmark, and Pin to Channel but it disappears instantly before it’s possible to select anything. Fix that.   
* In Bolt, there are a number of templates set up. They were created early on and while their subjects are pretty good, a lot of them aren’t well configured for what they’re actually supposed to do. Rebuild those templates. If it’s not possible to do what they describe purely using Bolt, keep track of these in a markdown document under docs/functionality-audits \- some may require sticking an agent in the middle of it and if so, we should surface that in the audit document so we can build that out later  
* In Banter, we can only create Banter channels one at a time. Add a rt-click menu for the “+” button that provides an “Add many” dialog where an admin can create a list of as many channels as they like, all at once.  
* Bond’s “Analytics” item goes to a black screen.  
* Blast’s SMTP settings are a placeholder UI that basically just says these are set in the environment. Since they can’t be set there it doesn’t make sense to have a whole UI with fields you can’t update. What’s actually true is that they are set in the “Account Settings \> Integrations” \- so it makes more sense to detect if the user is an Admin (or SuperUser) with access to that menu and to instruct them to go there if so, otherwise to tell them to contact an Org admin for assistance.  
* Bench \- it isn’t clear that the default “Bureau” metrics are working. In testing, I have definitely done multiple “summons” and so forth and they’re not showing up in Bench. It’s possible that it’s just tracking some older metric that we’re not reporting. Let’s make sure that the things Bench thinks it can track are actually things that are being reported and made trackable.

Additionally, these need attention just for discussing strategy \- for each, write up a strategy document (put them under \`docs/strategy\`) for how we should support them.

* Book: Booking pages. Under Construction page says it’s awaiting integration with Bond since booking meetings can be closely connected with CRM. We should close this loop.