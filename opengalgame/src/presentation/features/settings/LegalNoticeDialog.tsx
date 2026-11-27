import type { ReactElement } from 'react'

import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import styles from './LegalNoticeDialog.module.css'

export function LegalNoticeDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): ReactElement {
  return (
    <Dialog
      open={open}
      title="关于与许可"
      subtitle={`当前版本 ${__APP_VERSION__}`}
      size="wide"
      placement="center"
      surface="glass"
      allowClose
      onClose={onClose}
      actions={
        <Button variant="secondary" data-autofocus onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className={styles.body}>
        <section className={styles.block}>
          <h3 className={styles.heading}>许可与使用</h3>
          <p className={styles.text}>
            本软件按 Apache License 2.0
            发布。该许可证允许任何人免费或收费复制、修改、再分发本软件，也允许闭源分发；分发时必须保留版权、许可证和
            NOTICE 声明，并标明修改过的文件。
          </p>
          <p className={styles.text}>
            完整条款以 Apache License 2.0 正文为准，许可证文本随安装包提供，也可在
            https://www.apache.org/licenses/LICENSE-2.0 查看。
          </p>
        </section>

        <section className={styles.block}>
          <h3 className={styles.heading}>官方发行</h3>
          <p className={styles.text}>
            官方构建仅通过项目 GitHub Releases
            发布。其他渠道的销售、预装、代下载、网盘转载、修改版或托管服务，均为第三方独立发行，与本项目维护者没有隶属、代理、背书或担保关系。
          </p>
        </section>

        <section className={styles.block}>
          <h3 className={styles.heading}>第三方发行责任</h3>
          <p className={styles.text}>
            第三方发行由其提供者独立负责。维护者不对第三方版本的更新、支持、收费、安全性、数据、合规性或后续维护承担责任；因使用第三方版本产生的纠纷或损失，请向该发行方主张。官方支持仅覆盖官方构建。
          </p>
          <p className={styles.note}>
            Apache 2.0
            允许收费分发，因此第三方销售本身不因本说明而变成未经授权。本说明用于区分官方与第三方发行，不构成对许可证的修改。
          </p>
        </section>

        <section className={styles.block}>
          <h3 className={styles.heading}>无担保与责任限制</h3>
          <p className={styles.text}>
            本软件按“现状”提供，不附带任何明示或默示担保。在适用法律允许的最大范围内，维护者不对使用或无法使用本软件造成的间接、附带或后果性损失承担责任。完整条款以
            Apache License 2.0 正文为准。
          </p>
        </section>

        <section className={styles.block}>
          <h3 className={styles.heading}>名称与品牌</h3>
          <p className={styles.text}>
            Apache License 2.0
            不授予项目名称、图标或品牌标识的商标使用权。第三方版本不得以本项目官方名义宣传，也不得暗示获得维护者认可或支持。
          </p>
        </section>

        <section className={styles.block}>
          <h3 className={styles.heading}>第三方字体</h3>
          <p className={styles.text}>
            随包内置的字体按 SIL Open Font License 1.1
            分发；字体版权、保留字体名称和完整许可见安装包内字体许可目录。字体许可不构成对字体名称的商标授权。
          </p>
        </section>
      </div>
    </Dialog>
  )
}
