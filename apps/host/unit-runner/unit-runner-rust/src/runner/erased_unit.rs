//! [`UnitFactory`]: the app's factory with its unit type erased, so one
//! `UnitRunner` holds units of any type that share its `Detail`.
//!
//! One `UnitRunner<D>` holds units of different Rust types that share
//! `Detail = D`, and one map of mixed types needs `dyn`, so `set_unit` erases
//! each factory's unit type.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::run_context::RunContext;
use crate::unit::Unit;

/// A unit's run, as a boxed future.
pub(crate) type BoxedRun = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;

/// A unit whose type is erased.
pub(crate) trait ErasedUnit<D>: Send {
    /// Start the unit's run.
    fn run_boxed(self: Box<Self>, ctx: RunContext<D>) -> BoxedRun;
}

impl<U: Unit> ErasedUnit<U::Detail> for U {
    fn run_boxed(self: Box<Self>, ctx: RunContext<U::Detail>) -> BoxedRun {
        Box::pin((*self).run(ctx))
    }
}

/// Builds a fresh, type-erased unit for each run.
pub(crate) type UnitFactory<D> =
    Arc<dyn Fn() -> anyhow::Result<Box<dyn ErasedUnit<D>>> + Send + Sync>;

/// Erase the unit type `factory` builds.
pub(crate) fn erase_factory<U: Unit>(
    factory: impl Fn() -> anyhow::Result<U> + Send + Sync + 'static,
) -> UnitFactory<U::Detail> {
    Arc::new(move || {
        let unit = factory()?;
        Ok(Box::new(unit) as Box<dyn ErasedUnit<U::Detail>>)
    })
}
