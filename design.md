STYLEKIT_STYLE_REFERENCE
style_name: 粘土拟态
style_slug: claymorphism
style_source: /styles/claymorphism

# Hard Prompt

## 什么时候用
当你希望 AI 严格按风格规则生成代码时使用。它是生产界面最稳的默认选择。

## 怎么用
- 把完整提示词复制到 ChatGPT、Claude、Cursor 或其他编码助手。
- 在提示词后追加具体产品、页面或组件需求。
- 生成后按禁止项和交互状态检查，确认没有风格漂移。

请严格遵守以下风格规则并保持一致性，禁止风格漂移。

## 执行要求

- 优先保证风格一致性，其次再做创意延展。
- 遇到冲突时以禁止项为最高优先级。
- 输出前自检：颜色、排版、间距、交互是否仍属于该风格。

## Style Rules

# Claymorphism (粘土拟态) Design System

> 柔软的粘土质感设计，通过超大圆角、内外阴影组合和柔和渐变，创造出可爱的 3D 立体效果，适合儿童应用和趣味产品。

## 核心理念

Claymorphism（粘土拟态）是一种模拟粘土或橡皮泥质感的 UI 设计风格，通过超大圆角、内外阴影组合和柔和的渐变色彩，创造出柔软、可爱的 3D 立体效果。

核心理念：
- 柔软感：超大圆角和柔和阴影营造软糯质感
- 立体感：内阴影 + 外阴影组合模拟 3D 效果
- 趣味性：糖果色系和圆润造型传递愉悦情绪
- 触感：设计元素看起来像可以触摸和捏揉
- Q弹物理：按压时发生挤压形变，松开后弹性回弹

设计原则：
- 视觉一致性：所有组件必须遵循统一的视觉语言，从色彩到字体到间距保持谐调
- 层次分明：通过颜色深浅、字号大小、留白空间建立清晰的信息层级
- 交互反馈：每个可交互元素都必须有明确的 hover、active、focus 状态反馈
- 响应式适配：设计必须在移动端、平板、桌面端上保持一致的体验
- 无障碍性：确保色彩对比度符合 WCAG 2.1 AA 标准，所有交互元素可键盘访问

---

## Token 字典（精确 Class 映射）

### 边框
```
宽度: border-0
颜色: border-transparent
圆角: rounded-3xl
```

### 阴影
```
小:   shadow-[4px_4px_8px_rgba(0,0,0,0.08),inset_2px_2px_4px_rgba(255,255,255,0.5),inset_-1px_-1px_2px_rgba(0,0,0,0.05)]
中:   shadow-[8px_8px_16px_rgba(0,0,0,0.1),inset_4px_4px_8px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.1)]
大:   shadow-[12px_12px_24px_rgba(0,0,0,0.12),inset_6px_6px_12px_rgba(255,255,255,0.5),inset_-3px_-3px_6px_rgba(0,0,0,0.1)]
悬停: hover:shadow-[4px_4px_8px_rgba(0,0,0,0.1),inset_4px_4px_8px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.1)]
聚焦: focus:shadow-[8px_8px_16px_rgba(0,0,0,0.1),inset_4px_4px_8px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.1),0_0_0_4px_rgba(248,180,217,0.3)]
```

### 交互效果
```
悬停位移: hover:translate-y-1
悬停缩放: （无）
悬停透明度: （无）
过渡动画: transition-all duration-200
按下状态: active:translate-y-2
```

### 字体
```
标题: font-bold text-pink-700
正文: text-pink-600
等宽: font-mono text-pink-500
```

### 字号
```
Hero:  text-4xl md:text-6xl
H1:    text-3xl md:text-5xl
H2:    text-2xl md:text-3xl
H3:    text-xl md:text-2xl
正文:  text-base
小字:  text-sm
```

### 间距
```
Section: py-16 md:py-24
容器:    px-6 md:px-8
卡片:    p-6 md:p-8
小间距:  gap-4
中间距:  gap-6
大间距:  gap-8
```

### 颜色角色
```
背景主色: bg-gradient-to-br from-amber-100 via-pink-100 to-purple-100
背景辅色: bg-gradient-to-br from-white to-pink-50
背景强调色: bg-gradient-to-b from-pink-300 to-pink-400, bg-gradient-to-b from-green-200 to-green-300, bg-gradient-to-b from-purple-200 to-purple-300, bg-gradient-to-b from-yellow-200 to-yellow-300
正文主色: text-pink-700
正文辅色: text-pink-600
正文弱化色: text-pink-400
按钮主色: bg-gradient-to-b from-pink-300 to-pink-400 text-white
按钮辅色: bg-gradient-to-b from-amber-200 to-amber-300 text-amber-800
```

---

## [FORBIDDEN] 绝对禁止

以下 class 在本风格中**绝对禁止使用**，生成时必须检查并避免：

### 禁止的 Class
- `rounded-none`
- `rounded-sm`
- `rounded`
- `shadow-none`
- `bg-black`
- `text-black`
- `border-black`

### 禁止的模式
- 匹配 `^rounded-(?:none|sm|md)$`
- 匹配 `^shadow-\[\d+px_\d+px_0px`
- 匹配 `^bg-(?:black|gray-900|slate-900)`

### 禁止原因
- `rounded-none`: Claymorphism requires large rounded corners (rounded-3xl or larger)
- `rounded-sm`: Claymorphism requires large rounded corners (rounded-3xl or larger)
- `shadow-none`: Claymorphism requires combined inner and outer shadows for 3D effect
- `bg-black`: Claymorphism uses soft, candy-colored backgrounds
- `text-black`: Claymorphism uses soft colored text, not pure black

> WARNING: 如果你的代码中包含以上任何 class，必须立即替换。

---

## [REQUIRED] 必须包含

### 按钮必须包含
```
bg-gradient-to-b from-pink-300 to-pink-400
rounded-full
text-white font-bold
shadow-[8px_8px_16px_rgba(0,0,0,0.1),inset_4px_4px_8px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.1)]
hover:translate-y-1
transition-all duration-200
```

### 卡片必须包含
```
bg-gradient-to-br from-white to-pink-50
rounded-[32px]
shadow-[12px_12px_24px_rgba(0,0,0,0.1),inset_6px_6px_12px_rgba(255,255,255,0.6),inset_-4px_-4px_8px_rgba(0,0,0,0.05)]
```

### 输入框必须包含
```
bg-gradient-to-b from-gray-100 to-gray-200
rounded-2xl
shadow-[inset_4px_4px_8px_rgba(0,0,0,0.1),inset_-4px_-4px_8px_rgba(255,255,255,0.9)]
focus:outline-none
transition-all
```

---

## [COMPARE] Claymorphism 错误 vs 正确对比

以下错误示例只代表“未经过当前风格适配的通用默认值”，不要把错误示例当成视觉建议。

### 按钮

[WRONG] **错误示例**（通用组件库默认样式，不要直接复制）：
```html
<button class="{GENERIC_LIBRARY_BUTTON_DEFAULT}">
  点击我
</button>
```

[CORRECT] **正确示例**（使用 Claymorphism 的 token）：
```html
<button class="bg-gradient-to-b from-pink-300 to-pink-400 rounded-full text-white font-bold shadow-[8px_8px_16px_rgba(0,0,0,0.1),inset_4px_4px_8px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.1)] hover:translate-y-1 transition-all duration-200 bg-gradient-to-b from-pink-300 to-pink-400 text-white">
  点击我
</button>
```

### 卡片

[WRONG] **错误示例**（未经当前风格适配的通用卡片）：
```html
<div class="{GENERIC_LIBRARY_CARD_DEFAULT}">
  <h3>{TITLE}</h3>
</div>
```

[CORRECT] **正确示例**（使用 Claymorphism 的 card token）：
```html
<div class="bg-gradient-to-br from-white to-pink-50 rounded-[32px] shadow-[12px_12px_24px_rgba(0,0,0,0.1),inset_6px_6px_12px_rgba(255,255,255,0.6),inset_-4px_-4px_8px_rgba(0,0,0,0.05)] p-6 md:p-8">
  <h3 class="font-bold text-pink-700 text-xl md:text-2xl">{TITLE}</h3>
</div>
```

### 输入框

[WRONG] **错误示例**（未经当前风格适配的通用输入框）：
```html
<input class="{GENERIC_LIBRARY_INPUT_DEFAULT}" />
```

[CORRECT] **正确示例**（使用 Claymorphism 的 input token）：
```html
<input class="bg-gradient-to-b from-gray-100 to-gray-200 rounded-2xl shadow-[inset_4px_4px_8px_rgba(0,0,0,0.1),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] focus:outline-none transition-all" placeholder="{PLACEHOLDER}" />
```

---

## [TEMPLATES] Claymorphism 页面骨架模板

以下骨架只使用当前风格的 token。替换 `{PLACEHOLDER}` 时，不要移除或替换这些 token：

### 导航栏骨架
```html
<nav class="bg-gradient-to-br from-amber-100 via-pink-100 to-purple-100 text-pink-700 border-0 border-transparent px-6 md:px-8">
  <div class="flex items-center justify-between max-w-6xl mx-auto gap-6">
    <a href="/" class="font-bold text-pink-700 text-xl md:text-2xl">
      {LOGO_TEXT}
    </a>
    <div class="flex gap-6 text-pink-600 text-sm">
      {NAV_LINKS}
    </div>
  </div>
</nav>
```

### Hero 区块骨架
```html
<section class="bg-gradient-to-b from-pink-300 to-pink-400 text-pink-700 py-16 md:py-24 px-6 md:px-8">
  <div class="max-w-4xl mx-auto">
    <h1 class="font-bold text-pink-700 text-4xl md:text-6xl">
      {HEADLINE}
    </h1>
    <p class="text-pink-600 text-base max-w-xl">
      {SUBHEADLINE}
    </p>
    <button class="bg-gradient-to-b from-pink-300 to-pink-400 rounded-full text-white font-bold shadow-[8px_8px_16px_rgba(0,0,0,0.1),inset_4px_4px_8px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.1)] hover:translate-y-1 transition-all duration-200 bg-gradient-to-b from-pink-300 to-pink-400 text-white">
      {CTA_TEXT}
    </button>
  </div>
</section>
```

### 卡片网格骨架
```html
<section class="bg-gradient-to-br from-amber-100 via-pink-100 to-purple-100 text-pink-700 py-16 md:py-24 px-6 md:px-8">
  <div class="max-w-6xl mx-auto">
    <h2 class="font-bold text-pink-700 text-2xl md:text-3xl">{SECTION_TITLE}</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <!-- Card template - repeat for each card -->
      <div class="bg-gradient-to-br from-white to-pink-50 rounded-[32px] shadow-[12px_12px_24px_rgba(0,0,0,0.1),inset_6px_6px_12px_rgba(255,255,255,0.6),inset_-4px_-4px_8px_rgba(0,0,0,0.05)] p-6 md:p-8">
        <h3 class="font-bold text-pink-700 text-xl md:text-2xl">{CARD_TITLE}</h3>
        <p class="text-pink-600 text-base text-pink-400">{CARD_DESCRIPTION}</p>
      </div>
    </div>
  </div>
</section>
```

### 表单输入骨架
```html
<input class="bg-gradient-to-b from-gray-100 to-gray-200 rounded-2xl shadow-[inset_4px_4px_8px_rgba(0,0,0,0.1),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] focus:outline-none transition-all" placeholder="{PLACEHOLDER}" />
```

### 页脚骨架
```html
<footer class="bg-gradient-to-br from-white to-pink-50 text-pink-600 py-16 md:py-24 px-6 md:px-8">
  <div class="max-w-6xl mx-auto">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <div>
        <span class="font-bold text-pink-700 text-xl md:text-2xl">{LOGO_TEXT}</span>
        <p class="text-pink-600 text-sm">{TAGLINE}</p>
      </div>
      <div>
        <h4 class="font-bold text-pink-700 text-xl md:text-2xl">{COLUMN_TITLE}</h4>
        <ul class="text-pink-600 text-sm">
          {FOOTER_LINKS}
        </ul>
      </div>
    </div>
  </div>
</footer>
```

---

## [CHECKLIST] Claymorphism 生成后自检清单

**输出代码前，逐项验证当前风格的 token 和规则。如有违反，先修正再交付：**

### Token 检查
- [ ] 按钮包含：`bg-gradient-to-b from-pink-300 to-pink-400 rounded-full text-white font-bold shadow-[8px_8px_16px_rgba(0,0,0,0.1),inset_4px_4px_8px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.1)] hover:translate-y-1 transition-all duration-200`
- [ ] 卡片包含：`bg-gradient-to-br from-white to-pink-50 rounded-[32px] shadow-[12px_12px_24px_rgba(0,0,0,0.1),inset_6px_6px_12px_rgba(255,255,255,0.6),inset_-4px_-4px_8px_rgba(0,0,0,0.05)]`
- [ ] 输入框包含：`bg-gradient-to-b from-gray-100 to-gray-200 rounded-2xl shadow-[inset_4px_4px_8px_rgba(0,0,0,0.1),inset_-4px_-4px_8px_rgba(255,255,255,0.9)] focus:outline-none transition-all`

### 禁止项检查
- [ ] 没有使用 `rounded-none`
- [ ] 没有使用 `rounded-sm`
- [ ] 没有使用 `rounded`
- [ ] 没有使用 `shadow-none`
- [ ] 没有使用 `bg-black`
- [ ] 没有使用 `text-black`
- [ ] 没有使用 `border-black`

### 风格规则检查
- [ ] 使用超大圆角 rounded-3xl 或 rounded-full
- [ ] 组合内阴影和外阴影创造立体感
- [ ] 使用柔和的糖果色系配色
- [ ] 添加微妙的渐变背景模拟光照
- [ ] 保持元素之间足够的间距

### 风格漂移检查
- [ ] 没有违反：禁止使用尖锐的直角 rounded-none
- [ ] 没有违反：禁止使用硬边缘阴影 shadow-[Xpx_Xpx_0px]
- [ ] 没有违反：禁止使用高对比度的深色配色
- [ ] 没有违反：禁止使用过于复杂的渐变
- [ ] 没有违反：禁止元素过于拥挤

### 通用交付检查
- [ ] 响应式布局在手机、平板和桌面下稳定，没有横向溢出
- [ ] 所有交互元素有清晰焦点、可访问名称和 reduced-motion 方案
- [ ] 文本对比度达到 WCAG AA，且没有用颜色单独传递状态
- [ ] 结果仍然能够一眼识别为 Claymorphism，没有混入其他风格的模板

---

## [EXAMPLES] 示例 Prompt

### 1. 儿童教育应用

可爱的学习界面

```
用 Claymorphism 风格创建一个儿童教育应用界面，要求：
1. 背景：柔和的渐变（粉色到紫色或黄色到橙色）
2. 主卡片：超大圆角，粘土质感阴影，hover 时上浮
3. 按钮：圆润的胶囊形状，按下时 scale-x-105 scale-y-90 形变，弹簧缓动回弹
4. 图标：使用圆润的图标风格
5. 配色：糖果色系，明亮但不刺眼
```

### 2. 游戏 UI

趣味游戏界面

```
用 Claymorphism 风格设计一个休闲游戏界面，要求：
1. 背景：多彩渐变，营造欢乐氛围
2. 游戏卡片：立体粘土效果，hover 时上浮，点击时形变
3. 分数显示：大号圆润数字
4. 按钮：Play、Pause、Settings 等，都是粘土风格，active 时 Squash & Stretch
5. 所有过渡使用 ease-[cubic-bezier(0.34,1.56,0.64,1)]
```

### 3. 作品集展示

生成 粘土拟态风格的作品集页面

```
Create a portfolio showcase page using Claymorphism style with project grid, about section, contact form, and consistent visual language.
```

## 绝对禁止（匹配即拒绝）

以下模式一旦出现，视为风格违规——不找借口，直接重写。

- 使用尖锐的直角 rounded-none
- 使用硬边缘阴影 shadow-[Xpx_Xpx_0px]
- 使用高对比度的深色配色
- 使用过于复杂的渐变
- 元素过于拥挤
- 使用单纯的 translate-y 代替真实的形变物理
- 使用线性 ease 或 ease-in-out（无弹性感）

## 自检清单（交付前逐条确认）

如果任何一条不通过，说明风格漂移了——修改后再交付。

- [ ] 没有紫色到蓝色的渐变
- [ ] 没有使用 Inter / Roboto / Geist 等过度使用的字体
- [ ] 没有嵌套卡片（卡片里面套卡片）
- [ ] 没有在彩色背景上放灰色文字
- [ ] 正文对比度满足 WCAG AA（≥4.5:1）
- [ ] 没有 bounce / elastic 缓动曲线
- [ ] 动效有 prefers-reduced-motion 备选方案
- [ ] 正文行宽不超过 65-75 个字符
- [ ] 没有单侧粗边框装饰（border-left/right accent stripe）
- [ ] 没有渐变文字（background-clip: text）
- [ ] 没有把玻璃态（glassmorphism）当作默认风格
- [ ] 没有 tiny uppercase tracked eyebrow 放在每个 section 标题上面
- [ ] 禁止使用尖锐的直角 rounded-none
- [ ] 禁止使用硬边缘阴影 shadow-[Xpx_Xpx_0px]
- [ ] 禁止使用高对比度的深色配色
- [ ] 禁止使用过于复杂的渐变
- [ ] 禁止元素过于拥挤