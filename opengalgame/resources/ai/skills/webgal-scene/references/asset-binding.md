# 引用映射

用途以图片、音频、视频卡上的用途说明为主要依据，对应生成输入里的 description。提示词正文只作补充和细化。卡片 role 只是默认提示，不是授权依据。选择素材时必须符合命令类别：图片命令只用图片素材，音频命令只用音频素材，视频命令只用视频素材，不跨图片、音频、视频。不根据扩展名判断背景、CG、立绘、头像、音乐、音效或配音。

使用运行输入 assetBindings.commandReference，它是命令中性的稳定素材引用，来自编排登记后的工程相对路径。assets/<来源存储键>/dansei.png 对应 changeBg:<来源存储键>/dansei.png;，不能把 assets/ 或 game/ 整段写进命令。已经放在种类目录下的路径仍去掉该目录，比如 assets/background/station.svg 对应 changeBg:station.svg;。嵌套目录保留。

assetBindings 里的 purpose 和 defaultRuntimeDirectory 只是来源类别的默认提示，不是可用命令或目录限制；用途说明决定的命令才决定资源目录。4.6.5 映射：背景与 CG 在 background；立绘、头像在 figure；音乐在 bgm；音效和配音在 vocal；视频在 video。命令引用相对对应资源类型目录，保持大小写，不拼完整工程路径，不引用未提供素材。

例如来源 assets/<存储键>/duck.ogg 的默认提示可能是 game/bgm，但用途说明为音效时写 playEffect:<存储键>/duck.ogg;，解析到 game/vocal/<存储键>/duck.ogg；同一文件也可写 bgm:<存储键>/duck.ogg; 解析到 game/bgm。不需要移动或复制源文件。

非必要演出缺失可以省略并说明；影响剧情或确认要求的素材缺失必须报告取舍。不得下载或生成素材。
