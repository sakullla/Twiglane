use std::sync::Arc;

use tokio::sync::watch;

#[derive(Clone)]
pub struct Shutdown {
    inner: Arc<Inner>,
}

struct Inner {
    tx: watch::Sender<bool>,
    rx: watch::Receiver<bool>,
}

impl Shutdown {
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self {
            inner: Arc::new(Inner { tx, rx }),
        }
    }

    pub fn cancel(&self) {
        let _ = self.inner.tx.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.inner.tx.borrow()
    }

    pub async fn cancelled(&self) {
        let mut rx = self.inner.rx.clone();
        if *rx.borrow() {
            return;
        }
        loop {
            if rx.changed().await.is_err() {
                return;
            }
            if *rx.borrow() {
                return;
            }
        }
    }
}

impl Default for Shutdown {
    fn default() -> Self {
        Self::new()
    }
}
