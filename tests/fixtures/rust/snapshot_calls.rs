use std::collections::{HashMap, hash_map::{self, Entry as E}};
use crate::{a::b::{c, d as dd}, e::*};
pub use self::inner::Thing;

mod inner {
    pub struct Thing(pub u8);
}

pub trait Visit<T: Clone> {
    fn visit(&mut self, t: &T) -> bool;
    fn done(&self) {
        self.log();
    }
    fn log(&self) {}
}

pub struct Walker<'a, R> {
    root: &'a str,
    items: Vec<R>,
    map: HashMap<String, Box<dyn Visit<u8>>>,
}

impl<'a, R: Clone> Walker<'a, R> {
    pub fn new(root: &'a str) -> Self {
        Self { root, items: Vec::new(), map: HashMap::new() }
    }

    fn run(&mut self, v: &mut impl Visit<u8>, extra: Option<R>) -> Result<(), String> {
        let n: usize = self.items.len();
        let w = Walker::<R>::new(self.root);
        w.items.iter().map(|x| x.clone()).count();
        v.visit(&1);
        self.map.get("k").unwrap().done();
        helper(n, /* comment */ 2)?;
        <Self as Visit<u8>>::log(self);
        println!("{}", format!("{n}"));
        inner::Thing(3);
        Some(extra).unwrap();
        Ok(())
    }
}

impl<'a, R: Clone> Visit<u8> for Walker<'a, R> {
    fn visit(&mut self, t: &u8) -> bool {
        self.done();
        *t > 0
    }
}

fn helper(a: usize, b: usize) -> Result<usize, String> {
    let f = |x: usize| x + 1;
    Ok(f(a) + b)
}
