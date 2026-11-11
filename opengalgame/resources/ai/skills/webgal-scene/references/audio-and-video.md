# 音频与视频

`bgm:theme.ogg -volume=60;` 使用 game/bgm/theme.ogg，音量为百分尺度数值，不能套用 0～1 小数。背景音乐一旦设置就持续播放，换背景、切换表情或播放一次音效都不要再次写 `bgm`。只有需要换曲时才再次写 `bgm`；结束时写 `bgm:none;`。结尾停止即可，不要求淡出，只使用 `bgm` 与 `bgm:none`。

`playEffect:bell.ogg;` 使用 game/vocal/bell.ogg，音效并非独立 soundEffect 资源目录，也只播放一次。带配音的对白可用 `say:你好 -speaker=林 -vocal=hello.ogg -volume=60;`，配音同样从 vocal 解析。音效、音乐和配音命令按输入说明（description）选择；role/purpose 只是默认提示，不锁定命令。同一音频可按说明分别写 `bgm`、`playEffect` 或配音，不要求与默认用途同名，也不需要复制或移动文件：默认提示为 game/bgm 的音频说明为音效时仍用 `playEffect`。`playEffect` 或 `bgm` 与 `end` 之间必须保留一条等待玩家的对白或其他停顿语句，否则自动推进队列可能在音效启动前被 `end` 清空。

playVideo:opening.mp4; 引用 game/video/。按当前版本参数及任务需要控制推进；音视频文件可达不代表浏览器能解码。报告未执行的播放验证。
