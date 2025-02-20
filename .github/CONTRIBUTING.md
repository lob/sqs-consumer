# How to contribute
We welcome contributions from the community and are pleased to have them. Please follow this guide when logging issues or making code changes.

## Logging Issues
All issues should be created using the [new issue form](https://github.com/lob/sqs-consumer/issues/new/choose). Clearly describe the issue including steps to reproduce if there are any. Also, make sure to indicate the earliest version that has the issue being reported.
* Before opening a new issue, first check that there is not already an [open issue or Pull Request](https://github.com/lob/sqs-consumer/issues?utf8=%E2%9C%93&q=is%3Aopen) that addresses it.

## Contributing Code
Code changes are welcome and should follow the guidelines below.

* Fork the repository on GitHub.
* Add tests for your new code ensuring that you have 100% code coverage (we can help you reach 100% but will not merge without it).
    * Run `npm test` to generate a report of the test coverage
* If you're unsure if a feature would make a good addition, you can always [create an issue](https://github.com/lob/sqs-consumer/issues/new/choose) first. Raising an issue before creating a pull request is recommended.
* Any API changes should be fully documented.
* Make sure your code meets our linting standards. Run `npm run lint` to check your code.
* [Pull requests](https://help.github.com/articles/about-pull-requests/) should be made to the [main branch](https://github.com/lob/sqs-consumer/tree/main).

To help encourage consistent code style guidelines, we have included an `.editorconfig` file for use with your favorite [editor](http://editorconfig.org/#download).

Read more about EditorConfig [here](http://editorconfig.org/).