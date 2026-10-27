plugins {
    kotlin("jvm") version "2.3.0"
    id("com.gradleup.shadow") version "9.3.0"
}

group = "ru.ruscrafting"
version = "0.1.3"
description = "Live read-only browser views of selected Minecraft locations"

repositories {
    mavenCentral()
    maven("https://repo.rus-crafting.ru/grocermc/")
    maven("https://repo.papermc.io/repository/maven-public/")
}

java { toolchain { languageVersion.set(JavaLanguageVersion.of(25)) } }
kotlin { jvmToolchain(25) }

dependencies {
    implementation(kotlin("stdlib"))
    implementation("ru.ruscrafting.arc:arc-core:2.7.72")
    implementation("ru.ruscrafting.arc:arc-core-logging:2.7.72")
    implementation("ru.ruscrafting.arc:arc-core-paper:2.7.72")
    compileOnly("ru.ruscrafting.arc:arc-core-paper-api:2.7.72")
    compileOnly("io.papermc.paper:paper-api:1.21.11-R0.1-SNAPSHOT")
    implementation("com.google.code.gson:gson:2.13.2")
    testImplementation("io.kotest:kotest-runner-junit5:6.0.7")
    testImplementation("io.kotest:kotest-assertions-core:6.0.7")
    testImplementation("io.mockk:mockk:1.14.7")
    testImplementation("ru.ruscrafting.arc:arc-core-paper-testing:2.7.72")
    testImplementation("ru.ruscrafting.arc:arc-core-paper-api:2.7.72")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    jvmArgs("-Djdk.attach.allowAttachSelf=true", "-XX:+EnableDynamicAgentLoading")
    maxParallelForks = 1
    forkEvery = 1
}
tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}
tasks.processResources {
    inputs.property("pluginVersion", project.version.toString())
    filesMatching("plugin.yml") { expand("version" to project.version) }
    from("web/dist") { into("web") }
}
tasks.jar { archiveClassifier.set("plain") }
val verificationHost = configurations.detachedConfiguration(
    dependencies.create("ru.ruscrafting:ArcCore:0.1.23"),
).apply { isTransitive = false }
val prepareHostArtifact by tasks.registering(Copy::class) {
    from({ verificationHost.singleFile }) { rename { "ArcCore.jar" } }
    into(layout.buildDirectory.dir("verification"))
}
tasks.shadowJar {
    dependsOn(prepareHostArtifact)
    archiveClassifier.set("")
    mergeServiceFiles()
    relocate("com.google.gson", "ru.arc.worldview.lib.gson")
    exclude("ru/arc/paper/api/**", "ru/arc/metrics/**", "org/bukkit/**", "io/papermc/**", "org/slf4j/**", "net/kyori/adventure/**")
    exclude("ru/arc/paper/sql/PaperSqlServiceProvider*.class", "ru/arc/paper/sql/SharedPaperSqlService*.class")
    exclude("ru/arc/paper/redis/PaperRedisServiceProvider*.class", "ru/arc/paper/redis/SharedPaperRedisService*.class")
    exclude("ru/arc/paper/metrics/PaperArcMetricsProvider*.class", "ru/arc/paper/packet/PaperVisualPacketRuntime*.class")
    exclude("ru/arc/paper/runtime/PaperNativeCleanupServiceProvider*.class")
    exclude("ru/arc/paper/scene/PaperSceneObservationServiceProvider*.class", "ru/arc/paper/scene/PaperSceneEntityInfoServiceProvider*.class")
}
