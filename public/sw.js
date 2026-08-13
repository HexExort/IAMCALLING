self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { type: 'message', from: 'Кто-то', body: 'Новое уведомление' };
  }

  let title, body;
  if (data.type === 'call') {
    title = `Входящий звонок от ${data.from}`;
    body = 'Нажмите, чтобы открыть';
  } else {
    title = `Сообщение от ${data.from}`;
    body = data.body || '';
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon.png',
      badge: '/icon.png',
      tag: data.type === 'call' ? 'incoming-call' : 'chat-message',
      requireInteraction: data.type === 'call'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return clients.openWindow('/');
    })
  );
});
