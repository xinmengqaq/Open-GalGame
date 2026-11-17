/**
 * 导出链写入、预览宿主兜底共用的 WebGAL `game/` 默认文件文本。
 * 只拥有文本；命中路径、响应头和写入方式由各自消费方决定。
 * 修改这里会同时改变导出产物与预览缺失时的回落内容，两者必须保持同一份事实。
 */

/** 导出链写入的单场景 `game/config.txt`。 */
export const DEFAULT_GAME_CONFIG = `Game_name:当前场景;
Game_key:;
Title_img:;
Title_bgm:;
`

/** 只保留黑色 letterbox 底色的 `game/userStyleSheet.css`。 */
export const DEFAULT_USER_STYLE_SHEET = 'html,body{background:#000}\n'
