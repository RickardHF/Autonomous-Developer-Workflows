# Task 4 : CI/CD Checks

![04_CICD_Checks](/exercises/images/04_CICD_Checks.png)

Running verifications, checks and evaluations on agents and skills ad-hoc is great, and works well during testing and development. However in a normal work enviornment there is high preasure and different people who collaborate. Therefore running evaluations as part of our CI/CD processes are a good thing, just as we tend to do with unit testing.

> [!TIP]
> The AI might assume that all errors outputted by the evaluator are fatal and should block any merge.
> However we expect there to be some errors, they might be transient and there is a retry functionality, so often we will see an error and still have a score

> [!TIP]
> Get your agent to help setting up the branch protection ruleset

## Tasks

Create workflows that trigger on pull requests where the agent and skill files are changed, similarily to how we do tests for software. Your implementation should satisfy the requirements listed below.

### Requirements

- [ ] Make a workflow evaluate all **changed** agent definitions and skill definitions on pull requests
- [ ] Store scores per artifact (one skill folder counts as one artifact)
- [ ] Compare current scores with previous ones, if an agent score is more than 2 point lower than it was previously the test/check fails
- [ ] Enforce branch protection rules on the repository

> [!TIP]
> Specify that required reviewers should not be needed. As a lone developer on a project this is hard to satisfy

### Verification

To test the changes please follow these steps

- Go to one of the *.agent.md files and start editing it (you can do this in the browser)
  - Select one with a low score around 4-5 so that it's not too hard to improve it later on
- Remove the 'name' field or make any other changes that should result in a '0' score
- Commit -> you should get information that you need to create a new branch for the commit
- Create pull request for the new branch
- Check that the workflows fails and blocks the pr from being merged
- Fix the agent definition, push the changes -> the new run should approve the changes and allow you to merge ()

---

**Previous:** [← 3. Improving Skill Evaluations](03_Improving_Skill_Evaluations.md)  
**Next:** [5. Creating Orchestrations →](05_Creating_Orchestrations.md)
