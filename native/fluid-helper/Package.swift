// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShadiFlowFluidHelper",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(
            name: "shadiflow-fluid-helper",
            targets: ["ShadiFlowFluidHelper"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "82aed2ab25ea5b6526509a917f738f11f7bec328"),
    ],
    targets: [
        .executableTarget(
            name: "ShadiFlowFluidHelper",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/ShadiFlowFluidHelper"
        ),
    ]
)
