# **BigBlueBam \- Frndo launch notes**

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
  * No task can be marked Done unless all of its subtasks are marked Done

