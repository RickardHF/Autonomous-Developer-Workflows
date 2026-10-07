# Task 5 : Creating Agent Orchestrations

![05_Creating_Orchestrations](/exercises/images/05_Creating_Orchestrations.png)

When creating orchestrations and workflows for agents there are many different approaches we can take, and there are different levels of complexity we can implement.

In this repo alone we can see multiple ways one can implement it. The [orchestrator agent](/.github/agents/orchestrator.agent.md) is one way we can orchestrate multiple agents; having one agent spin up multiple sub agents and manage them in order to solve a goal.

Another way is to create GitHub Actions for instance that run agents in specific steps based on events like in the [Plan and Implement](/.github/workflows/plan-implement.yml) workflow.

There are a multitude of other options as well and many different tools. There are many features of AI tools that can be used, but also many open source tools that can be utilized.

## Tasks

To better understand this concept and for the ease of working and testing the code we will create a script locally to create some orchestration. You're free to choose how to create the script; if you want to use bash, powershell, or node/pyhthon/c#/etc. utilizing the SDKs.

> [!TIP]
> When using AI for this the agents tend to overcomplicate sometimes leaving you with a complicated code that is hard to follow and understand, something which is not great for the purpose of the workshop. Also getting a complicated flow to work might also be more difficult as you can run into issues with sandbox permissions, machine permissions etc that can make it harder.
> Even stating to make it simple, you still might end up with something which is hundreds of lines of code. Worth being extra specific about this.
> Stating that the algorithm not to create worktrees, make it work on all specified issues from the same environment etc can make it easier to vrify and check results.

### Requirements

- [ ] Possible to trigger locally
- [ ] Takes in one or more issues as input
  - In case of multiple then it should loop over the same process for each of the issues.
- [ ] Assigns the orchestrator agent to resolve the GitHub Issue
- [ ] After the orchestrator is done have a new agent review the changes
  - Failed review -> move back to previous step. Orchestrator is given instructions of what to fix
  - Succeeded -> continues
- [ ] Max amount of rounds
  - Number reached -> park the implementation effort, continue to next issue

Use the open issues on the repo to test out the workflow. If you run out of issues use the description-to-github-issues skill with a description of additional features to run.

---

**Previous:** [← 4. CI/CD Checks](04_CICD_Checks.md)  
**Next:** [6. Tying it Together →](06_Tying_It_Together.md)
