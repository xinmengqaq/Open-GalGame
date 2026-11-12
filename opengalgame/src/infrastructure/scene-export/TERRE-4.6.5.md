# Terre 4.6.5 Windows 导出模板

导出只使用官方发布包中的 `WebGAL_Electron_Template` 和 `WebGAL_Template`。发布包不进入源码仓库。

- 版本：`4.6.5`
- 来源：<https://github.com/OpenWebGAL/WebGAL_Terre/releases/download/4.6.5/WebGAL_Terre_Windows_4.6.5.zip>
- 目标提交：`cf73dd58535d3ef15bddf0852adee153fa92d7da`
- 大小：174,584,841 字节
- SHA-256：`3100b12e01f9ec9fabaf893b1f5caf8c18c5ca36f537b3c8055ea48462d57c9d`
- 许可：MPL-2.0。模板包含 Electron 29、Chromium 和 Steamworks 运行库。

查找顺序：

1. `OPENGALGAME_TERRE_WINDOWS_RELEASE`
2. 当前用户目录 `templates/terre-4.6.5/WebGAL_Terre_Windows_4.6.5.zip`
3. `%LOCALAPPDATA%/opengalgame/templates/terre-4.6.5/WebGAL_Terre_Windows_4.6.5.zip`
4. 从 GitHub Release API 资产 `586152709` 下载到当前用户目录，并按上面的大小和 SHA-256 校验

显式配置了第 1 项但文件不存在或校验失败时，不再继续查找或下载。
