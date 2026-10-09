# Cohub App 架构分析与移动端实现建议

## 网页版 App 架构概览

### 1. **App 运行机制**

根据对 Cohub 网页版代码的分析，App 的运行机制类似微信小程序：

#### 关键组件：

**AppSurface.svelte** - App 的容器组件
- 支持多种内容类型：
  - `web`: 嵌入式网页（通过 iframe）
  - `port`: 端口服务（通过 iframe）
  - `board`: 原生 Board 渲染
  - `file`: 原生文件渲染
- 三种运行模式：
  - `page`: 独立页面模式
  - `background`: 后台运行模式
  - `app`: 应用窗口模式

**AppPreviewController** - App 预览控制器
- 管理多个 App 的生命周期
- 支持 App 的打开、关闭、切换
- 处理 App 之间的通信
- 类似浏览器的标签页管理

**AppBridgeHost** - App 通信桥接
- 提供 App 与宿主环境的通信通道
- 处理权限请求（Authorization）
- 管理 App 的运行时上下文（Invocation Context）
- 处理导航、Commerce、Composer 等功能

### 2. **App 权限与授权**

**授权流程：**
1. App 通过 `client.auth.request()` 请求权限
2. 宿主显示授权对话框（AppAuthorizeDialog）
3. 用户授予权限后，App 可以访问对应的 SDK API
4. 权限与 Space 绑定，支持多种 scopes

**关键 API：**
```typescript
// 请求权限
await client.auth.request({
  scopes: Permission[],
  reason?: string,
  spaceId?: string,
  alwaysAsk?: boolean
});

// 请求 Space 选择
await client.auth.requestSpace({
  scopes: Permission[],
  reason?: string,
  alwaysAsk?: boolean
});

// 请求创建新 Space
await client.auth.requestCreateSpace({
  scopes: Permission[],
  space: CreateSpaceInput,
  reason?: string
});
```

### 3. **App 运行时上下文**

**Invocation Context（调用上下文）：**
- `surface`: 运行表面（page/background/app）
- `source`: 来源（如何被调用的）
- `spaceId`: 当前 Space ID
- `sessionId`: 当前 Session ID（如果在对话中）
- `turnId`: 当前 Turn ID
- `toolCallId`: Tool Call ID（如果作为工具被调用）

**Shell Context（外壳上下文）：**
- 提供宿主环境信息
- URL、导航状态等

### 4. **App 通信机制**

**PostMessage Bridge：**
- App 通过 iframe 运行时，使用 postMessage 与宿主通信
- 协议化的消息格式（@cohub/protocol）
- 支持请求-响应模式
- 类型安全的 API 调用

**Surface RPC：**
- App 可以注册可调用的方法
- 宿主可以通过 `callSurface` 调用 App 方法
- 支持超时控制
- 用于 Desktop Commands 等场景

---

## 移动端实现建议

### 方案一：WebView + Bridge（推荐）

类似微信小程序的架构：

#### 架构设计：

```typescript
// App 容器组件
<AppContainer>
  {/* 原生导航栏 */}
  <AppHeader />
  
  {/* App 内容区 */}
  {contentKind === 'web' || contentKind === 'port' ? (
    <WebView 
      source={{ uri: contentUrl }}
      onMessage={handleBridgeMessage}
      injectedJavaScript={bridgeScript}
    />
  ) : contentKind === 'board' ? (
    <NativeBoardView />
  ) : (
    <NativeFileView />
  )}
  
  {/* 权限授权弹窗 */}
  <AppAuthDialog />
</AppContainer>
```

#### 关键实现：

**1. Bridge 通信层**
```typescript
// src/features/app/AppBridge.ts
export class AppBridge {
  private webview: WebView;
  private messageHandlers: Map<string, Handler>;
  
  constructor(webview: WebView, app: AppRecord) {
    this.webview = webview;
    this.setupMessageHandler();
  }
  
  // 处理来自 App 的消息
  handleMessage(event: WebViewMessageEvent) {
    const message = JSON.parse(event.nativeEvent.data);
    
    switch (message.type) {
      case 'auth.request':
        return this.handleAuthRequest(message);
      case 'api.call':
        return this.handleApiCall(message);
      case 'navigation.open':
        return this.handleNavigation(message);
      // ... 更多消息类型
    }
  }
  
  // 向 App 发送消息
  postMessage(message: any) {
    this.webview.injectJavaScript(`
      window.postMessage(${JSON.stringify(message)}, '*');
    `);
  }
}
```

**2. 权限管理**
```typescript
// src/features/app/AppAuthorization.ts
export function useAppAuthorization() {
  const [pendingAuth, setPendingAuth] = useState<AuthRequest | null>(null);
  
  async function requestAuthorization(request: AuthRequest) {
    setPendingAuth(request);
    
    // 显示原生授权对话框
    const granted = await showAuthDialog(request);
    
    if (granted) {
      // 保存授权记录
      await saveGrant(request.appId, request.scopes);
    }
    
    setPendingAuth(null);
    return granted;
  }
  
  return { pendingAuth, requestAuthorization };
}
```

**3. App 容器管理**
```typescript
// src/features/app/AppContainer.tsx
export function AppContainer({ appId }: { appId: string }) {
  const { client } = useApp();
  const [detail, setDetail] = useState<AppDetailResponse | null>(null);
  const [bridge, setBridge] = useState<AppBridge | null>(null);
  const webviewRef = useRef<WebView>(null);
  
  useEffect(() => {
    // 加载 App 详情
    client.apps.get(appId).then(setDetail);
  }, [appId]);
  
  useEffect(() => {
    if (!detail || !webviewRef.current) return;
    
    // 创建 Bridge
    const bridge = new AppBridge(webviewRef.current, detail.app);
    setBridge(bridge);
    
    return () => bridge.dispose();
  }, [detail]);
  
  if (!detail) return <LoadingScreen />;
  
  const contentUrl = detail.content?.url;
  
  return (
    <Screen>
      <AppHeader app={detail.app} space={detail.space} />
      
      {contentUrl ? (
        <WebView
          ref={webviewRef}
          source={{ uri: contentUrl }}
          onMessage={(event) => bridge?.handleMessage(event)}
          injectedJavaScript={BRIDGE_SCRIPT}
        />
      ) : (
        <EmptyState />
      )}
      
      <AppAuthDialog bridge={bridge} />
    </Screen>
  );
}
```

**4. Bridge 注入脚本**
```javascript
// src/features/app/bridge-script.js
const BRIDGE_SCRIPT = `
(function() {
  // 拦截 SDK 的网络请求
  window.__cohubBridge = {
    postMessage: function(message) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    },
    
    // SDK 通过这个方法调用 Native API
    request: function(method, params) {
      return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36);
        
        window.__cohubBridge.pending[requestId] = { resolve, reject };
        
        window.__cohubBridge.postMessage({
          type: 'api.call',
          requestId,
          method,
          params
        });
      });
    },
    
    pending: {}
  };
  
  // 接收来自 Native 的响应
  window.addEventListener('message', function(event) {
    const message = event.data;
    if (message.requestId && window.__cohubBridge.pending[message.requestId]) {
      const { resolve, reject } = window.__cohubBridge.pending[message.requestId];
      delete window.__cohubBridge.pending[message.requestId];
      
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.result);
      }
    }
  });
})();
`;
```

#### 目录结构建议：

```
src/features/app/
├── AppBridge.ts              # Bridge 通信核心
├── AppContainer.tsx          # App 容器组件
├── AppHeader.tsx             # App 顶部栏
├── AppAuthDialog.tsx         # 授权对话框
├── AppWebView.tsx            # WebView 封装
├── AppBoardView.tsx          # Board 原生渲染
├── AppFileView.tsx           # File 原生渲染
├── bridge-script.js          # 注入脚本
├── app-authorization.ts      # 权限管理
├── app-lifecycle.ts          # 生命周期管理
└── types.ts                  # 类型定义
```

---

### 方案二：原生组件（长期方案）

为常用的 App 类型提供原生实现：

1. **Board App**: 使用 React Native Skia 渲染
2. **File App**: 原生文档查看器
3. **Port App**: 保留 WebView 方案
4. **Web App**: 保留 WebView 方案

---

## 关键技术点

### 1. **权限系统**
- 使用 AsyncStorage 存储授权记录
- 按 (appId, spaceId, scope) 三元组管理
- 支持撤销和重新授权

### 2. **生命周期管理**
- App 打开/关闭事件
- 前后台切换
- 内存管理（限制同时运行的 App 数量）

### 3. **安全性**
- WebView 沙箱隔离
- 权限最小化原则
- 敏感 API（如支付）需要额外确认

### 4. **性能优化**
- App 预加载
- WebView 池复用
- 懒加载非必要功能

---

## 实现路线图

### Phase 1: 基础架构（2-3 周）
1. ✅ App 详情页面和编辑功能（已完成）
2. App Bridge 通信层
3. WebView 容器组件
4. 基础权限管理

### Phase 2: 完善功能（2-3 周）
1. 授权对话框 UI
2. App 多窗口管理
3. Navigation API 支持
4. Commerce API 支持

### Phase 3: 原生优化（3-4 周）
1. Board 原生渲染
2. File 原生查看器
3. 性能优化
4. 错误处理和日志

### Phase 4: 高级功能（按需）
1. App 间通信
2. Background 模式
3. Desktop Commands
4. 推送通知集成

---

## 总结

Cohub 的 App 系统确实类似微信小程序，核心是：

1. **容器化运行**: App 在受控的 WebView 或原生容器中运行
2. **权限隔离**: 通过权限系统控制 App 的能力
3. **Bridge 通信**: 标准化的宿主-App 通信协议
4. **生命周期管理**: 统一的打开、关闭、切换机制

移动端实现的关键是建立一个健壮的 Bridge 层，让 Web App 可以无缝运行，同时为原生渲染留出扩展空间。

建议先实现 WebView + Bridge 方案，验证可行性后再逐步添加原生优化。
