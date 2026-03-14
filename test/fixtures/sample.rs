use std::collections::HashMap;

pub trait Storage {
    fn get(&self, key: &str) -> Option<&str>;
    fn set(&mut self, key: String, value: String);
}

#[derive(Debug, Clone)]
pub struct MemoryStore {
    data: HashMap<String, String>,
}

impl Storage for MemoryStore {
    fn get(&self, key: &str) -> Option<&str> {
        self.data.get(key).map(|s| s.as_str())
    }

    fn set(&mut self, key: String, value: String) {
        self.data.insert(key, value);
    }
}

pub fn create_store() -> MemoryStore {
    MemoryStore {
        data: HashMap::new(),
    }
}
