# **BigBlueBam \- Frndo Launch notes**

Study the history and current status of the project, specifically around development principles and practices. There’s a lot of documentation \- it should explain anything you need to know. Below is a set of requirements to meet or features to implement. Work through each one in order, launching agent swarms to address each one.

You will need to operate largely unattended. Do not stop working to ask questions \- use your best judgement, document your decisions, and present them for human review as you finish.

Rebuild local Docker images as needed to test in simulated production. Run unit tests and smoke tests as you wrap up each requirement. When something fails, track down the source. If you find a bug while working, add the bug to the list of tasks and solve it: we do not leave known bugs in the software just because they were “pre-existing”.

* Git  
  * Create and work in a branch while building this out.  
  * Check in code persistently: every feature should get a check-in with a meaningful commit message. Always push immediately after testing completes successfully.  
* CLI  
  * Is there any documentation for the B3 CLI? If not, make one.  
  * Since there isn’t a “reset-password” command yet, we should add one.  
* User Management Issues  
  * Even with email configured, user does not receive an invitation email when they are invited   
  * There should also be a “send password reset” that sends a password reset link to the user  
  * Reset Password doesn’t display the new password to the admin resetting it (sometimes necessary if to provide to user)  
  * Creating a user should not only provide the ability to add to an organization but to trivially add to Project(s) under that organization  
    * Currently you have to go into the user editor and add them to the project by hand  
* When adding tasks in BAM, there’s the ability to add subtasks but they just look like any other task: there’s no visible association between subtasks and parent tasks.  
  * Any task with subtasks should have some sort of subtasks field with its subtasks available there  
  * Any task that is a subtask of another task (or tasks) should have a parent tasks field where its parent task or tasks is available.  
  * Any task can have none, one, or more subtasks \- or parent tasks \- a single subtask might support multiple parent tasks, for example, because they are each dependant on it.  
  * No BAM task can be marked Done unless all of its subtasks are marked Done

Continue iterating through the list, looping over the list again at the end to make sure everything is complete. If it has not completed successfully, it has not been deferred \- do not assume we’ll run it through the next command.