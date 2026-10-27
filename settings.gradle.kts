rootProject.name = "ArcWorldView"

providers.gradleProperty("arcCoreDir").orNull?.let(::file)?.let { root ->
    includeBuild(root) {
        dependencySubstitution {
            listOf("arc-core", "arc-core-logging", "arc-core-paper", "arc-core-paper-api", "arc-core-paper-testing").forEach { name ->
                substitute(module("ru.ruscrafting.arc:$name")).using(project(":$name"))
            }
        }
    }
}
